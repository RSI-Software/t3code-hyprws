// @effect-diagnostics nodeBuiltinImport:off - Durable maintainer evidence uses content-addressed records.
import * as NodeCrypto from "node:crypto";
import {
  requireSequentialCensusEvidence,
  type SequentialCensusEvidence,
} from "./fork-rebase-issues.ts";
export interface CensusFile {
  readonly path: string;
  readonly hunks: number | null;
  readonly commit: string;
  readonly subject?: string;
  readonly domain: string;
}

export interface CensusSnapshot {
  readonly tag: string;
  readonly fixedAt: string | null;
  readonly files: ReadonlyArray<CensusFile>;
  readonly censusEvidence?: SequentialCensusEvidence;
}

export interface FrozenObservation {
  readonly kind: "observation";
  readonly method: "legacy-pairwise-feasibility" | SequentialCensusEvidence["method"];
  readonly tag: string;
  readonly files: ReadonlyArray<CensusFile>;
  readonly evidence: SequentialCensusEvidence | null;
}

interface RowReference {
  readonly observation: string;
  readonly row: number;
}

interface MaintainerAttestation {
  readonly actor: string;
  /** Published maintainer record, not a claim that the importer executed a check. */
  readonly evidenceUrl: string;
}

interface SeamMapping {
  readonly kind: "mapping";
  readonly from: RowReference;
  readonly to: ReadonlyArray<RowReference>;
  readonly attestation: MaintainerAttestation;
}

interface SeamRepair {
  readonly kind: "repair";
  readonly before: RowReference;
  readonly changeSha: string;
  readonly guard: string;
  readonly attestation: MaintainerAttestation;
}

interface SeamVerification {
  readonly kind: "verification";
  readonly repair: string;
  readonly after: string;
  readonly guardProof: {
    readonly sourceSha: string;
    readonly command: string;
    readonly exitCode: number;
    readonly output: string;
  };
  readonly attestation: MaintainerAttestation;
}

export type SeamPayload = FrozenObservation | SeamMapping | SeamRepair | SeamVerification;
export type SeamRecord = SeamPayload & { readonly id: string };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
export const seamRecord = <T extends SeamPayload>(payload: T): T & { readonly id: string } => ({
  ...payload,
  id: digest(payload),
});

/** Ordinary replays preserve this observation identity; reviewed mappings extend it. */
const tuple = (row: CensusFile): string => {
  if (row.subject === undefined) throw new Error(`census subject is not enriched: ${row.commit}`);
  return JSON.stringify([row.path, row.subject, row.domain]);
};
export const seamIdentity = (row: CensusFile): string => digest(tuple(row));

export const freezeObservation = (snapshot: CensusSnapshot): FrozenObservation => ({
  kind: "observation",
  tag: snapshot.tag,
  files: snapshot.files,
  method: snapshot.censusEvidence?.method ?? "legacy-pairwise-feasibility",
  evidence: snapshot.censusEvidence ?? null,
});

const object = (value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected seam record object");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("unknown seam record field");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("expected nonempty seam record string");
  return value;
};
const sha = (value: unknown): string => {
  const result = text(value);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result))
    throw new Error("expected full seam evidence SHA");
  return result;
};
const reference = (value: unknown): RowReference => {
  const row = object(value, ["observation", "row"]);
  if (typeof row.row !== "number" || !Number.isSafeInteger(row.row) || row.row < 0)
    throw new Error("invalid observation row index");
  return { observation: text(row.observation), row: row.row };
};
const attestation = (value: unknown): MaintainerAttestation => {
  const row = object(value, ["actor", "evidenceUrl"]);
  const evidenceUrl = text(row.evidenceUrl);
  if (new URL(evidenceUrl).protocol !== "https:")
    throw new Error("maintainer attestation needs an HTTPS evidence URL");
  return { actor: text(row.actor), evidenceUrl };
};

const payload = (value: unknown): SeamPayload => {
  const row = object(value, [
    "id",
    "kind",
    "method",
    "tag",
    "files",
    "evidence",
    "from",
    "to",
    "attestation",
    "before",
    "changeSha",
    "guard",
    "repair",
    "after",
    "guardProof",
  ]);
  switch (row.kind) {
    case "observation": {
      object(row, ["id", "kind", "method", "tag", "files", "evidence"]);
      if (!Array.isArray(row.files)) throw new Error("observation needs frozen files");
      const files = row.files.map((value: unknown): CensusFile => {
        const file = object(value, ["path", "hunks", "commit", "subject", "domain"]);
        if (
          file.hunks !== null &&
          (typeof file.hunks !== "number" || !Number.isSafeInteger(file.hunks) || file.hunks < 0)
        )
          throw new Error("invalid observation hunks");
        return {
          path: text(file.path),
          hunks: file.hunks,
          commit: text(file.commit),
          domain: text(file.domain),
          ...(file.subject === undefined ? {} : { subject: text(file.subject) }),
        };
      });
      const evidence = row.evidence === null ? null : requireSequentialCensusEvidence(row.evidence);
      const method = evidence?.method ?? "legacy-pairwise-feasibility";
      if (row.method !== method) throw new Error("observation measurement method mismatch");
      const tag = text(row.tag);
      if (evidence !== null) {
        const observedFiles = evidence.rows.map((item) => ({
          path: item.path,
          hunks: null,
          commit: item.commit,
          subject: item.subject,
          domain: item.domain ?? "?",
        }));
        if (evidence.targetTag !== tag || canonical(observedFiles) !== canonical(files))
          throw new Error("frozen census rows or target do not match their provenance");
      }
      return { kind: "observation", method, tag, files, evidence };
    }
    case "mapping": {
      object(row, ["id", "kind", "from", "to", "attestation"]);
      if (!Array.isArray(row.to) || row.to.length === 0)
        throw new Error("mapping needs at least one destination");
      return {
        kind: "mapping",
        from: reference(row.from),
        to: row.to.map(reference),
        attestation: attestation(row.attestation),
      };
    }
    case "repair":
      object(row, ["id", "kind", "before", "changeSha", "guard", "attestation"]);
      return {
        kind: "repair",
        before: reference(row.before),
        changeSha: sha(row.changeSha),
        guard: text(row.guard),
        attestation: attestation(row.attestation),
      };
    case "verification": {
      object(row, ["id", "kind", "repair", "after", "guardProof", "attestation"]);
      const proof = object(row.guardProof, ["sourceSha", "command", "exitCode", "output"]);
      if (
        typeof proof.exitCode !== "number" ||
        !Number.isSafeInteger(proof.exitCode) ||
        proof.exitCode < 0
      )
        throw new Error("invalid attested guard exit code");
      if (typeof proof.output !== "string") throw new Error("guard proof needs retained output");
      return {
        kind: "verification",
        repair: text(row.repair),
        after: text(row.after),
        guardProof: {
          sourceSha: sha(proof.sourceSha),
          command: text(proof.command),
          exitCode: proof.exitCode,
          output: proof.output,
        },
        attestation: attestation(row.attestation),
      };
    }
    default:
      throw new Error("unknown seam record kind");
  }
};

export const requireSeamRecords = (value: unknown): ReadonlyArray<SeamRecord> => {
  if (!Array.isArray(value)) throw new Error("seamRecords must be an array");
  const records: Array<SeamRecord> = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = payload(item);
    const record = seamRecord(parsed);
    if ((item as Record<string, unknown>).id !== record.id)
      throw new Error("seam record digest mismatch");
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  const registry = recordRegistry(records);
  for (const record of records) {
    if (record.kind === "repair") registry.row(record.before);
    if (record.kind !== "verification") continue;
    const repair = registry.byId.get(record.repair);
    if (repair?.kind !== "repair") throw new Error("verification needs a recorded repair");
    const after = registry.observation(record.after);
    if (after.evidence === null || record.guardProof.sourceSha !== after.evidence.sourceSha)
      throw new Error("guard proof is not bound to the frozen verification head");
  }
  return records;
};

const recordRegistry = (records: ReadonlyArray<SeamRecord>) => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const observation = (id: string): FrozenObservation => {
    const record = byId.get(id);
    if (record?.kind !== "observation") throw new Error(`missing frozen observation: ${id}`);
    return record;
  };
  const row = (ref: RowReference): CensusFile => {
    const result = observation(ref.observation).files[ref.row];
    if (result === undefined)
      throw new Error("mapping or repair row is outside frozen observation");
    return result;
  };
  const aliases = new Map<string, string>();
  const identity = (file: CensusFile): string => aliases.get(tuple(file)) ?? seamIdentity(file);
  for (const record of records) {
    if (record.kind !== "mapping") continue;
    const from = row(record.from);
    const id = identity(from);
    aliases.set(tuple(from), id);
    for (const target of record.to) {
      const key = tuple(row(target));
      const existing = aliases.get(key);
      if (existing !== undefined && existing !== id)
        throw new Error("conflicting reviewed seam mappings");
      aliases.set(key, id);
    }
  }
  return { byId, observation, row, identity };
};

export type SeamStatus =
  | "observed"
  | "not-observed"
  | "unknown"
  | "returned-unresolved"
  | "repair-unverified"
  | "verified-repaired"
  | "regressed";
export interface SeamAssessment {
  readonly id: string;
  readonly path: string;
  readonly subject: string;
  readonly domain: string;
  readonly commit: string;
  readonly tag: string;
  readonly status: SeamStatus;
  readonly blocking: boolean;
  readonly repairSha: string | null;
  readonly guard: string | null;
  readonly reason: string;
}

const comparable = (before: FrozenObservation, after: FrozenObservation): boolean =>
  before.evidence !== null &&
  after.evidence !== null &&
  before.evidence.complete &&
  after.evidence.complete &&
  before.method === after.method &&
  before.evidence.baseSha === after.evidence.baseSha &&
  before.evidence.targetSha === after.evidence.targetSha;

export const assessSeams = (
  snapshots: ReadonlyArray<CensusSnapshot>,
  records: ReadonlyArray<SeamRecord>,
): ReadonlyArray<SeamAssessment> => {
  const registry = recordRegistry(records);
  const states = new Map<string, SeamAssessment>();
  const absent = new Set<string>();
  const observations = snapshots.map(freezeObservation);
  for (const observation of observations) {
    const present = new Set<string>();
    for (const file of observation.files) {
      const id = registry.identity(file);
      present.add(id);
      const previous = states.get(id);
      const returned = absent.has(id) || previous?.blocking === true;
      states.set(id, {
        id,
        path: file.path,
        subject: file.subject!,
        domain: file.domain,
        commit: file.commit,
        tag: observation.tag,
        status: returned ? "returned-unresolved" : "observed",
        blocking: returned,
        repairSha: null,
        guard: null,
        reason: returned
          ? "Returned without comparable repair verification."
          : "Observed; no repair is implied.",
      });
    }
    for (const [id, state] of states) {
      if (present.has(id)) continue;
      const partial = observation.evidence?.complete === false;
      if (!partial) absent.add(id);
      states.set(id, {
        ...state,
        tag: observation.tag,
        status: partial ? "unknown" : "not-observed",
        reason: partial
          ? "Partial census cannot establish absence."
          : "Not observed; unresolved identity retained.",
      });
    }
  }
  const latest = observations.at(-1);
  for (const record of records) {
    if (record.kind !== "repair") continue;
    const file = registry.row(record.before);
    const id = registry.identity(file);
    const state =
      states.get(id) ??
      ({
        id,
        path: file.path,
        subject: file.subject!,
        domain: file.domain,
        commit: file.commit,
        tag: registry.observation(record.before.observation).tag,
        status: "unknown",
        blocking: false,
        repairSha: null,
        guard: null,
        reason: "No current census.",
      } satisfies SeamAssessment);
    let next: SeamAssessment = {
      ...state,
      status: "repair-unverified",
      repairSha: record.changeSha,
      guard: record.guard,
      reason: "Named repair awaits comparable verification.",
    };
    const before = registry.observation(record.before.observation);
    let verifiedRepair = false;
    for (const verification of records) {
      if (verification.kind !== "verification" || verification.repair !== record.id) continue;
      const after = registry.observation(verification.after);
      if (!comparable(before, after)) {
        next = {
          ...next,
          reason: "Verification is not comparable (method, target, base or completeness differs).",
        };
        continue;
      }
      const guardPassed = verification.guardProof.exitCode === 0;
      const repaired = guardPassed && !after.files.some((row) => registry.identity(row) === id);
      const previouslyVerified = verifiedRepair;
      if (repaired) verifiedRepair = true;
      const current = latest ?? after;
      const currentPresent = current.files.some((row) => registry.identity(row) === id);
      if (!guardPassed) {
        next = {
          ...next,
          status: previouslyVerified ? "regressed" : "repair-unverified",
          blocking: true,
          reason: "Maintainer attests the named guard failed on the frozen verification head.",
        };
      } else if (
        repaired &&
        comparable(after, current) &&
        !currentPresent &&
        current.evidence?.sourceSha === after.evidence?.sourceSha
      ) {
        next = {
          ...next,
          status: "verified-repaired",
          blocking: false,
          reason:
            "Complete comparable replay is clear; maintainer attests the guard passed on this head.",
        };
      } else if (repaired && currentPresent) {
        next = {
          ...next,
          status: comparable(after, current) ? "regressed" : "returned-unresolved",
          blocking: true,
          reason: comparable(after, current)
            ? "Seam returned after comparable verified repair."
            : "Seam returned on a different measurement basis; renewed verification is required.",
        };
      } else if (repaired) {
        next = {
          ...next,
          status: "unknown",
          reason:
            "Repair was verified, but the current observation is not comparable or uses a different head.",
        };
      } else {
        next = {
          ...next,
          status: previouslyVerified ? "regressed" : "returned-unresolved",
          blocking: true,
          reason: "The guarded seam is still observed in the verification replay.",
        };
      }
    }
    states.set(id, next);
  }
  return [...states.values()].toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id),
  );
};
