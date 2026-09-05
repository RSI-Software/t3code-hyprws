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

export type PriorUatStatus = "accepted" | "unsettled";

export interface UatTask {
  readonly area: string;
  readonly title: string;
  readonly carriedFrom: ReadonlyArray<{
    readonly issue: number;
    readonly status: PriorUatStatus;
  }>;
}

export interface PreviousUat {
  readonly issue: number;
  readonly url: string;
  readonly tasks: ReadonlyArray<UatTask>;
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
  readonly previousUat: PreviousUat | null;
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

const trailingFindingLink = /\s+\(\[[^\]]+\]\([^)]+\)\)\s*$/;

const closeConditionOnly = (title: string): boolean =>
  title.startsWith("Every UAT row above") || /^`v\d+\.\d+\.\d+-hyprws\.\d+` is tagged/.test(title);

export const legacyUatTasks = (body: string, issue: number): ReadonlyArray<UatTask> => {
  let section: "uat" | "close" | null = null;
  let area = "Acceptance";
  const tasks: Array<UatTask> = [];
  for (const line of body.split(/\r?\n/)) {
    const second = /^## (.+)$/.exec(line)?.[1];
    if (second !== undefined) {
      section = second === "UAT" ? "uat" : second === "Close condition" ? "close" : null;
      area = "Acceptance";
      continue;
    }
    if (section === null) continue;
    const third = /^### (.+)$/.exec(line)?.[1];
    if (third !== undefined) {
      area = third;
      continue;
    }
    const row = /^- \[([ xX])\] (.+)$/.exec(line);
    if (row === null || area === "Sign-off") continue;
    const title = (row[2] ?? "").replace(trailingFindingLink, "").trim();
    if (title.length === 0 || closeConditionOnly(title)) continue;
    tasks.push({
      area,
      title,
      carriedFrom: [{ issue, status: row[1] === " " ? "unsettled" : "accepted" }],
    });
  }
  return tasks;
};

const carryMarker = /<!-- fork-uat:carried-from #([1-9][0-9]*) (accepted|unsettled) -->/g;

export const reviewedUatTasks = (body: string): ReadonlyArray<UatTask> => {
  const heading = /^## UAT\s*$/m.exec(body);
  if (heading === null) throw new Error("reviewed draft has no ## UAT section");
  const after = body.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(after);
  const section = next === null ? after : after.slice(0, next.index);
  let area: string | null = null;
  const tasks: Array<UatTask> = [];
  for (const line of section.split(/\r?\n/)) {
    const third = /^### (.+)$/.exec(line)?.[1];
    if (third !== undefined) {
      area = third;
      continue;
    }
    const row = /^- \[ \] (.+)$/.exec(line);
    if (row === null) continue;
    if (area === null) throw new Error("reviewed draft UAT row has no feature heading");
    const raw = row[1] ?? "";
    const carriedFrom = [...raw.matchAll(carryMarker)].map((match) => ({
      issue: Number(match[1]),
      status: match[2] as PriorUatStatus,
    }));
    const title = raw.replace(carryMarker, "").trim();
    if (title.length === 0) throw new Error("reviewed draft has an empty UAT row");
    tasks.push({ area, title, carriedFrom });
  }
  const normalized = new Set<string>();
  for (const task of tasks) {
    const key = task.title.toLocaleLowerCase().replace(/\s+/g, " ");
    if (normalized.has(key)) throw new Error(`reviewed draft repeats UAT task: ${task.title}`);
    normalized.add(key);
  }
  if (tasks.length === 0) throw new Error("reviewed draft has no unchecked UAT rows");
  return tasks;
};

export const parentUatBody = (body: string): string => {
  const heading = /^## UAT\s*$/m.exec(body);
  if (heading === null) throw new Error("reviewed draft has no ## UAT section");
  const after = body.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(after);
  const end = next === null ? body.length : heading.index + heading[0].length + next.index;
  const replacement = [
    "## Acceptance",
    "",
    "Acceptance is tracked by this issue's child tasks.",
    "",
    "<!-- fork-uat:subissues:v1 -->",
    "",
  ].join("\n");
  return `${body.slice(0, heading.index)}${replacement}${body.slice(end)}`;
};

export const renderUatTaskBody = (
  task: UatTask,
  snapshot: Pick<UatBodyInput, "targetVersion" | "ref" | "sha">,
): string => {
  const carried = task.carriedFrom.map(
    ({ issue, status }) =>
      `- RSI-Software/t3code-hyprws#${issue}: ${status === "accepted" ? "previously accepted" : "unsettled"}`,
  );
  return [
    `Origin: human acceptance task for \`${snapshot.targetVersion}\` at \`${snapshot.sha}\`.`,
    "",
    `- Area: ${task.area}`,
    `- Ref: \`${snapshot.ref}\``,
    `- Commit: \`${snapshot.sha}\``,
    ...(carried.length === 0 ? [] : ["", "## Previous evidence", "", ...carried]),
    "",
    "## Acceptance",
    "",
    task.title,
    "",
    "## Result",
    "",
    "Close this task when accepted. Leave unresolved behavior or polish opportunities open with their findings.",
    "",
    "<!-- fork-uat:task:v1 -->",
    "",
  ].join("\n");
};

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
  const carriedTasks = input.previousUat?.tasks ?? [];
  const tasks: Array<string> = [];
  let currentArea: string | null = null;
  for (const task of carriedTasks) {
    if (task.area !== currentArea) {
      if (tasks.length > 0) tasks.push("");
      tasks.push(`### ${task.area}`, "");
      currentArea = task.area;
    }
    const evidence = task.carriedFrom[0];
    tasks.push(
      `- [ ] ${task.title}${evidence === undefined ? "" : ` <!-- fork-uat:carried-from #${evidence.issue} ${evidence.status} -->`}`,
    );
  }
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
    "<!-- fork-uat:task-drafts:v1 -->",
    ...(tasks.length === 0 ? ["<!-- agent: write rows here, see SKILL.md -->"] : tasks),
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
    "Close every acceptance child after it passes.",
    "Leave follow-up or polish work open and record the finding on that child.",
    "Comment `Signed off` when this candidate is accepted in principle; open children remain non-blocking evidence.",
    "Withhold the stable release go only when the app cannot launch or basic use fails.",
    "",
  ].join("\n");
};
