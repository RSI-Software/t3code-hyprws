import {
  censusFilesFromEvidence,
  freezeObservation,
  requireSeamPayload,
  requireSeamRecords,
  seamRecord,
  type CensusFile,
  type FrozenObservation,
  type SeamRecord,
} from "./fork-churn-seams.ts";
import { requireSequentialCensusEvidence } from "./fork-rebase-issues.ts";

/**
 * Turns a local sequential rebase census into the reviewed bundle `fork-churn record --input`
 * imports. The artifact is a `RebaseStopCensus` exactly as `rehearseStopCensus` emits it, so a
 * frozen observation carries the same provenance the report path reads off an issue body and the
 * recorded seam can reach `verified-repaired` at all.
 *
 * The composer resolves references and nothing else. Every payload goes through the one seam
 * validator, guard results stay maintainer attestations, and no guard command is executed here.
 */
export interface SeamBundle {
  readonly version: 1;
  readonly records: ReadonlyArray<SeamRecord>;
}

const PLAN_FIELDS = ["version", "observations", "mappings", "repairs", "verifications"] as const;

const object = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`expected ${what} object`);
  return value as Record<string, unknown>;
};

const fields = (row: Record<string, unknown>, keys: ReadonlyArray<string>, what: string): void => {
  for (const key of Object.keys(row))
    if (!keys.includes(key)) throw new Error(`unknown ${what} field: ${key}`);
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`expected nonempty ${what}`);
  return value;
};

const list = (value: unknown, what: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(`expected ${what} array`);
  return value;
};

/**
 * A count-only census carries no provenance, so it can never found a comparable observation.
 * Refusing it here is the difference between an evidence-bearing record and the evidence-less
 * observations that made every seam permanently unprovable.
 */
export const observeStopCensus = (census: unknown): FrozenObservation => {
  const row = object(census, "sequential census artifact");
  if (row.evidence === undefined || row.evidence === null)
    throw new Error(
      "sequential census artifact carries no evidence; a count-only census cannot found an observation",
    );
  const evidence = requireSequentialCensusEvidence(row.evidence);
  if (row.targetTag !== evidence.targetTag)
    throw new Error("census target tag disagrees with its own retained evidence");
  // A truncated walk stopped early, so its silence about a path is not absence. Requiring the flag
  // and refusing a disagreement is what keeps a partial census `unknown` instead of `not-observed`.
  if (typeof row.truncated !== "boolean")
    throw new Error("sequential census artifact carries no truncated flag");
  if (row.truncated !== !evidence.complete)
    throw new Error("census truncation disagrees with its own retained evidence");
  return freezeObservation({
    tag: evidence.targetTag,
    fixedAt: null,
    files: censusFilesFromEvidence(evidence),
    censusEvidence: evidence,
  });
};

/**
 * Composes one reviewed bundle. `readCensus` resolves a plan's census reference to its artifact,
 * which keeps this pure and lets the CLI decide what a reference means on disk. `existing` is the
 * recorded ledger, so a plan may point at an already-published observation or repair by id.
 */
export const composeSeamBundle = (
  plan: unknown,
  readCensus: (reference: string) => unknown,
  existing: ReadonlyArray<SeamRecord> = [],
): SeamBundle => {
  const root = object(plan, "seam compose plan");
  if (root.version !== 1) throw new Error("expected seam compose plan {version:1, ...}");
  fields(root, PLAN_FIELDS, "seam compose plan");

  const records: Array<SeamRecord> = [];
  const observations = new Map<string, ReadonlyArray<CensusFile>>();
  const repairs = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const record of existing)
    if (record.kind === "observation") observations.set(record.id, record.files);

  const alias = (value: unknown, what: string): string => {
    const name = text(value, what);
    if (aliases.has(name)) throw new Error(`duplicate compose alias: ${name}`);
    return name;
  };

  const observationId = (value: unknown): string => {
    const name = text(value, "observation reference");
    const id = aliases.get(name) ?? name;
    if (!observations.has(id)) throw new Error(`unknown observation reference: ${name}`);
    return id;
  };

  // A reviewer names the row by path, because a row index in a 63-row census is unreadable and
  // silently wrong once the census is retaken. An explicit index stays available for a duplicate.
  const rowReference = (value: unknown): { readonly observation: string; readonly row: number } => {
    const row = object(value, "census row selector");
    fields(row, ["observation", "path", "commit", "row"], "census row selector");
    const observation = observationId(row.observation);
    if (row.row !== undefined) {
      if (row.path !== undefined || row.commit !== undefined)
        throw new Error("census row selector takes either an explicit index or a path");
      if (typeof row.row !== "number" || !Number.isSafeInteger(row.row) || row.row < 0)
        throw new Error("invalid observation row index");
      return { observation, row: row.row };
    }
    const path = text(row.path, "census row selector path");
    const commit = row.commit === undefined ? null : text(row.commit, "census row selector commit");
    const matches = (observations.get(observation) ?? []).flatMap((file, index) =>
      file.path === path && (commit === null || file.commit === commit) ? [index] : [],
    );
    if (matches.length !== 1)
      throw new Error(
        `census row selector matched ${matches.length} rows for ${path}; name the commit or the row index`,
      );
    return { observation, row: matches[0]! };
  };

  for (const entry of list(root.observations ?? [], "seam compose observations")) {
    const row = object(entry, "seam compose observation");
    fields(row, ["alias", "census"], "seam compose observation");
    const name = alias(row.alias, "observation alias");
    const observation = seamRecord(
      observeStopCensus(readCensus(text(row.census, "census reference"))),
    );
    aliases.set(name, observation.id);
    observations.set(observation.id, observation.files);
    records.push(observation);
  }

  for (const entry of list(root.mappings ?? [], "seam compose mappings")) {
    const row = object(entry, "seam compose mapping");
    fields(row, ["from", "to", "attestation"], "seam compose mapping");
    records.push(
      seamRecord(
        requireSeamPayload({
          kind: "mapping",
          from: rowReference(row.from),
          to: list(row.to, "seam compose mapping destinations").map(rowReference),
          attestation: row.attestation,
        }),
      ),
    );
  }

  for (const entry of list(root.repairs ?? [], "seam compose repairs")) {
    const row = object(entry, "seam compose repair");
    fields(row, ["alias", "before", "changeSha", "guard", "attestation"], "seam compose repair");
    const name = alias(row.alias, "repair alias");
    const record = seamRecord(
      requireSeamPayload({
        kind: "repair",
        before: rowReference(row.before),
        changeSha: row.changeSha,
        guard: row.guard,
        attestation: row.attestation,
      }),
    );
    aliases.set(name, record.id);
    repairs.set(name, record.id);
    records.push(record);
  }

  for (const entry of list(root.verifications ?? [], "seam compose verifications")) {
    const row = object(entry, "seam compose verification");
    fields(row, ["repair", "after", "guardProof", "attestation"], "seam compose verification");
    const name = text(row.repair, "repair reference");
    records.push(
      seamRecord(
        requireSeamPayload({
          kind: "verification",
          repair: repairs.get(name) ?? name,
          after: observationId(row.after),
          guardProof: row.guardProof,
          attestation: row.attestation,
        }),
      ),
    );
  }

  // Validate the composed bundle against the ledger it will land on, so a broken reference or an
  // incomparable passing verification fails here instead of at import.
  requireSeamRecords([...existing, ...records]);
  return { version: 1, records };
};
