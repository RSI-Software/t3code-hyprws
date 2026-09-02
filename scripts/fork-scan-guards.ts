// Authoring guards for `vp run fork:scan`, derived from what the churn ledger
// already charged us for. Each rule names a shape a later rebase pays for, at
// the moment a fork commit creates it rather than three walks later:
//
// - hot-seam: the commit touches a path the churn ledger lists as a hot seam.
// - upstream-test: the commit adds a fork test block to an upstream-owned test
//   file instead of its `*.fork.test.ts` sibling.
// - footprint: one commit spreads over more upstream files than the budget.
//
// Warnings are advisory. `fork:scan --strict` is what turns them fatal, so a
// rule can ship before the stack it describes is clean.

import { hotSeams, parseLedger } from "./fork-churn.ts";

// `#73` spans 12 hunks over 6 files in the v0.0.39-nightly.20260902.1256
// census, the largest footprint the ledger has had to replay by hand.
export const UPSTREAM_FOOTPRINT_BUDGET = 6;

export type ScanWarningRule = "hot-seam" | "upstream-test" | "footprint";

const RULE_ORDER: ReadonlyArray<ScanWarningRule> = ["hot-seam", "upstream-test", "footprint"];

export interface ScanWarning {
  readonly rule: ScanWarningRule;
  readonly commit: string;
  readonly domain: string;
  readonly detail: string;
}

export interface HotSeam {
  readonly walkCount: number;
  readonly worstClass: string;
}

export interface CommitPatch {
  // Added `it`/`test`/`describe` block openers, counted per file.
  readonly addedTestBlocks: ReadonlyMap<string, number>;
}

export interface GuardCommit {
  readonly sha: string;
  readonly short: string;
  readonly domain: string;
}

export interface GuardInput {
  // Only the commits the caller wants warned about: `--since` narrows a walk of
  // the whole stack to the commits one change introduces.
  readonly commits: ReadonlyArray<GuardCommit>;
  readonly filesBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly patchesBySha: ReadonlyMap<string, CommitPatch>;
  // Paths that exist in the upstream base tree. A fork-created file is the
  // repair every one of these rules points at, so it never triggers them.
  readonly upstreamFiles: ReadonlySet<string>;
  readonly hotSeams: ReadonlyMap<string, HotSeam>;
}

const PATCH_RECORD_SEPARATOR = "";

export const commitPatchArguments = (shas: ReadonlyArray<string>) =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--no-ext-diff",
    "--unified=0",
    `--format=${PATCH_RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

const TEST_BLOCK = /^\s*(?:it|test|describe)\s*(?:\.[\w$]+)*\s*(?:<[^>]*>)?\s*[(`]/;

const diffPath = (value: string): string | null => {
  const target = value.trim();
  return target === "/dev/null" ? null : target.replace(/^[ab]\//, "");
};

export const parseCommitPatches = (raw: string): ReadonlyMap<string, CommitPatch> => {
  const patches = new Map<string, CommitPatch>();
  for (const record of raw.replace(/\r\n/g, "\n").split(PATCH_RECORD_SEPARATOR)) {
    const [header = "", ...lines] = record.split("\n");
    const sha = header.trim();
    if (sha.length === 0) continue;
    const addedTestBlocks = new Map<string, number>();
    // A creation writes `--- /dev/null`, so an added line is attributed to the
    // target side of the pair rather than to one path per file.
    let targetPath: string | null = null;
    for (const line of lines) {
      if (line.startsWith("+++ ")) {
        targetPath = diffPath(line.slice(4));
        continue;
      }
      if (!line.startsWith("+") || targetPath === null) continue;
      if (!TEST_BLOCK.test(line.slice(1))) continue;
      addedTestBlocks.set(targetPath, (addedTestBlocks.get(targetPath) ?? 0) + 1);
    }
    patches.set(sha, { addedTestBlocks });
  }
  return patches;
};

export const readHotSeams = (churnLedger: string): ReadonlyMap<string, HotSeam> =>
  new Map(
    hotSeams(parseLedger(churnLedger)).map((seam) => [
      seam.path,
      { walkCount: seam.walkCount, worstClass: seam.worstClass },
    ]),
  );

const TEST_FILE = /\.test\.tsx?$/;
const FORK_TEST_FILE = /\.fork\.test\.tsx?$/;

export const forkTestSibling = (path: string): string =>
  path.replace(/\.test\.(tsx?)$/, ".fork.test.$1");

const EMPTY_PATCH: CommitPatch = { addedTestBlocks: new Map() };

export const collectScanWarnings = (input: GuardInput): ReadonlyArray<ScanWarning> => {
  const warnings: Array<ScanWarning> = [];

  for (const commit of input.commits) {
    const files = input.filesBySha.get(commit.sha) ?? [];
    const patch = input.patchesBySha.get(commit.sha) ?? EMPTY_PATCH;
    const upstreamTouched = files.filter((path) => input.upstreamFiles.has(path)).toSorted();
    const found: Array<ScanWarning> = [];
    const warn = (rule: ScanWarningRule, detail: string) => {
      found.push({ rule, commit: commit.short, domain: commit.domain, detail });
    };

    for (const path of upstreamTouched) {
      const seam = input.hotSeams.get(path);
      if (seam === undefined) continue;
      warn(
        "hot-seam",
        `${path} is a hot seam (${seam.walkCount} walk(s), worst class ${seam.worstClass}); read docs/internals/fork-churn.md before adding to it`,
      );
    }

    for (const [path, count] of [...patch.addedTestBlocks].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!input.upstreamFiles.has(path)) continue;
      if (!TEST_FILE.test(path) || FORK_TEST_FILE.test(path)) continue;
      warn(
        "upstream-test",
        `${path} gains ${count} fork test block(s); move them to ${forkTestSibling(path)}`,
      );
    }

    if (upstreamTouched.length > UPSTREAM_FOOTPRINT_BUDGET) {
      warn(
        "footprint",
        `${upstreamTouched.length} upstream file(s) in one commit (budget ${UPSTREAM_FOOTPRINT_BUDGET}); prefer one adapter boundary over edits spread across upstream files`,
      );
    }

    warnings.push(
      ...found.toSorted(
        (left, right) => RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule),
      ),
    );
  }

  return warnings;
};

export const renderScanWarnings = (warnings: ReadonlyArray<ScanWarning>): ReadonlyArray<string> => {
  if (warnings.length === 0) return [];
  const counts = RULE_ORDER.map(
    (rule) => [rule, warnings.filter((warning) => warning.rule === rule).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(", ");
  return [
    "",
    `Ledger guards, ${warnings.length} warning(s) (${counts}):`,
    ...warnings.map(
      (warning) =>
        `  WARN  ${warning.rule}  ${warning.commit}  ${warning.domain}  ${warning.detail}`,
    ),
  ];
};
