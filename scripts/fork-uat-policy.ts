import { FORK_REPOSITORY, parseStableForkTag, parseUpstreamReleaseTag } from "./lib/fork-policy.ts";

const REPOSITORY = FORK_REPOSITORY;

export interface ForkCommit {
  readonly sha: string;
  readonly short: string;
  readonly subject: string;
  readonly domain?: string;
  readonly tier?: string;
}

export interface ForkLedger {
  readonly commits: ReadonlyArray<ForkCommit>;
  readonly findings: ReadonlyArray<unknown>;
}

export interface DifferenceRow extends ForkCommit {
  readonly paths: ReadonlyArray<string>;
  readonly patchId: string | null;
}

export type ExclusionReason = "fork-meta" | "conventional" | "supporting-paths" | "upstream";

export interface ExcludedRow extends DifferenceRow {
  readonly reason: ExclusionReason;
}

export interface UatBodyInput {
  readonly ref: string;
  readonly sha: string;
  readonly targetVersion: string;
  readonly upstreamBaseTag: string;
  readonly upstreamBaseSha: string;
  readonly previousStable: string;
  readonly previousStableOverridden: boolean;
  readonly relatesTo: number | null;
  readonly sources: ReadonlyArray<{
    readonly short: string;
    readonly subject: string;
    readonly prBody: string | null;
  }>;
  readonly excluded: ReadonlyArray<Pick<ExcludedRow, "short" | "subject" | "reason">>;
}

export type Version = readonly [number, number, number];
type StableVersion = readonly [number, number, number, number];

const stableParts = (tag: string): StableVersion | null => {
  const parsed = parseStableForkTag(tag);
  return parsed === null ? null : [parsed.major, parsed.minor, parsed.patch, parsed.revision];
};

export const upstreamParts = (tag: string): Version | null => {
  const parsed = parseUpstreamReleaseTag(tag);
  return parsed === null ? null : [parsed.major, parsed.minor, parsed.patch];
};

export const compareNumbers = (
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const selectPreviousStable = (
  upstreamVersion: Version,
  tags: ReadonlyArray<string>,
  tagsOnRef: ReadonlyArray<string> = [],
): string | null => {
  const eligible = tags
    .flatMap((tag) => {
      const parts = stableParts(tag);
      return parts === null || compareNumbers(parts.slice(0, 3), upstreamVersion) > 0
        ? []
        : [{ tag, parts }];
    })
    .toSorted((left, right) => compareNumbers(left.parts, right.parts));
  const carried = tagsOnRef
    .flatMap((tag) => {
      const parts = stableParts(tag);
      return parts === null ? [] : [{ tag, parts }];
    })
    .toSorted((left, right) => compareNumbers(left.parts, right.parts))
    .at(-1);
  const candidates =
    carried === undefined
      ? eligible
      : eligible.filter((entry) => compareNumbers(entry.parts, carried.parts) < 0);
  return candidates.at(-1)?.tag ?? null;
};

export const differenceRows = (
  current: ReadonlyArray<ForkCommit>,
  previous: ReadonlyArray<ForkCommit>,
  patchId: (sha: string) => string | null,
  paths: (sha: string) => ReadonlyArray<string>,
): ReadonlyArray<DifferenceRow> => {
  const previousSubjects = new Set(previous.map((commit) => commit.subject));
  const previousPatchIds = new Set(
    previous.flatMap((commit) => {
      const value = patchId(commit.sha);
      return value === null ? [] : [value];
    }),
  );
  return current.flatMap((commit) => {
    if (previousSubjects.has(commit.subject)) return [];
    const candidatePatchId = patchId(commit.sha);
    if (candidatePatchId !== null && previousPatchIds.has(candidatePatchId)) return [];
    return [{ ...commit, patchId: candidatePatchId, paths: paths(commit.sha) }];
  });
};

const EXCLUDED_CONVENTIONAL_TYPES = new Set(["build", "chore", "ci", "docs", "refactor", "test"]);

const conventionalIdentity = (
  subject: string,
): { readonly type: string; readonly scope: string | null } | null => {
  const match = /^([a-z]+)(?:\(([^)]*)\))?!?:\s/.exec(subject);
  return match === null ? null : { type: match[1] ?? "", scope: match[2] ?? null };
};

const isSupportingPath = (path: string): boolean =>
  path.startsWith(".github/") ||
  path.startsWith("scripts/") ||
  path.startsWith("docs/") ||
  path.startsWith(".agents/") ||
  /(^|\/)[^/]+\.test\.[^/]+$/.test(path) ||
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|yarn\.lock|[^/]+\.lock)$/.test(
    path,
  );

export const exclusionReason = (
  row: Pick<DifferenceRow, "domain" | "paths" | "subject">,
  isUpstream = false,
): ExclusionReason | null => {
  if (row.domain === "fork-meta") return "fork-meta";
  const conventional = conventionalIdentity(row.subject);
  if (
    conventional !== null &&
    (EXCLUDED_CONVENTIONAL_TYPES.has(conventional.type) ||
      (conventional.scope === "fork" && ["ci", "docs"].includes(conventional.type)))
  ) {
    return "conventional";
  }
  if (row.paths.length > 0 && row.paths.every(isSupportingPath)) return "supporting-paths";
  if (isUpstream) return "upstream";
  return null;
};

export const partitionUatRows = (
  rows: ReadonlyArray<DifferenceRow>,
  isUpstream: (row: DifferenceRow) => boolean = () => false,
): {
  readonly rows: ReadonlyArray<DifferenceRow>;
  readonly excluded: ReadonlyArray<ExcludedRow>;
} => {
  const included: Array<DifferenceRow> = [];
  const excluded: Array<ExcludedRow> = [];
  for (const row of rows) {
    const reason = exclusionReason(row, isUpstream(row));
    if (reason === null) included.push(row);
    else excluded.push({ ...row, reason });
  }
  return { rows: included, excluded };
};

export const targetVersionFromUpstreamTag = (tag: string): string => {
  const version = upstreamParts(tag);
  if (version === null) throw new Error(`unsupported upstream release tag ${tag}`);
  return `v${version.join(".")}-hyprws`;
};

export const uatTitle = (targetVersion: string): string => `UAT ${targetVersion}`;

export const relationshipArguments = (relatesTo: number | null): ReadonlyArray<string> =>
  relatesTo === null ? ["--no-relationship"] : ["--relates-to", `${REPOSITORY}#${relatesTo}`];

const exclusionLabel = (reason: ExclusionReason): string => {
  if (reason === "fork-meta") return "Fork-Domain fork-meta";
  if (reason === "conventional") return "non-product conventional commit";
  if (reason === "supporting-paths") return "supporting paths only";
  return "already upstream";
};

export const renderUatBody = (input: UatBodyInput): string => {
  const sources = input.sources.map(
    (row) => `- \`${row.short}\` ${row.subject}${row.prBody === null ? "" : ` — ${row.prBody}`}`,
  );
  const excluded = input.excluded.map(
    (row) => `- \`${row.short}\` ${row.subject} — ${exclusionLabel(row.reason)}`,
  );
  const related =
    input.relatesTo === null ? [] : [`Related issue: \`${REPOSITORY}#${input.relatesTo}\`.`, ""];
  return [
    `Ref \`${input.ref}\` at \`${input.sha}\` is ready for human acceptance.`,
    "",
    `Origin: human acceptance for fork ref \`${input.ref}\`; evidence: \`vp run fork:delta --base upstream/main --head <snapshot> --json\` run for \`${input.sha}\` and \`${input.previousStable}\`.`,
    "",
    ...related,
    "## Snapshot",
    "",
    `- Target: \`${input.targetVersion}\``,
    `- Ref: \`${input.ref}\``,
    `- Commit: \`${input.sha}\``,
    `- Upstream base: \`${input.upstreamBaseTag}\` at \`${input.upstreamBaseSha}\``,
    `- Previous stable: \`${input.previousStable}\`${input.previousStableOverridden ? " (overridden)" : ""}`,
    "",
    "## Sources",
    "",
    "<details>",
    `<summary>Included product commits (${sources.length})</summary>`,
    "",
    ...sources,
    "",
    "</details>",
    "",
    "## UAT",
    "",
    "<!-- agent: write rows here, see SKILL.md -->",
    "",
    "## Excluded",
    "",
    "<details>",
    `<summary>Excluded non-product commits (${excluded.length})</summary>`,
    "",
    ...excluded,
    "",
    "</details>",
    "",
    "## Close condition",
    "",
    "Tick every accepted row and add findings as comments.",
    "Comment `Signed off` when this ref is accepted, or `Blocked: <reason>` when it is not.",
    "Unticked or blocked rows are human decision evidence; they do not gate automatically.",
    "",
  ].join("\n");
};
