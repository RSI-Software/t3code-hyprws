#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git check runs before an Effect runtime exists.

// Checks every fork domain's rebase scan against the shared files its own
// commits touch. Shared means the fork changed the file above its upstream base
// and upstream changed it too on the way to the target, which is where a rebase
// silently merges two intents, so the file must be listed in that domain's
// rebase-scan table in docs/fork/internals/fork-delta.md. The target defaults to
// live `upstream/main`; `--target <tag>` pins a release and reproduces the
// automerged-overlap walk gate 3 of the fork-sync skill used to do by hand.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { forkLogArguments, parseForkLog, type ForkCommit } from "./fork-delta.ts";
import {
  type AuthoringGuardCommit,
  collectAuthoringWarnings,
  commitPatchArguments,
  parseCommitPatches,
  renderAuthoringWarnings,
  significantTestLines,
  type CommitPatch,
  type ScanAuthoringWarning,
} from "./fork-scan-authoring.ts";
import { UsageError } from "./lib/fork-cli.ts";
import {
  hookGuardWarnings,
  GENERATED_HOOK_PATH,
  MARKER_CAPABLE_PATH,
} from "./lib/fork-hook-guard.ts";
import {
  checkAdditive,
  renderAdditiveFindings,
  type AdditiveFinding,
} from "./lib/fork-additive-gate.ts";
import { overlapPaths } from "./lib/fork-overlap.ts";
import {
  assessForkSupersedes,
  collectForkSupersedes,
  type SituatedDeclaration,
} from "./lib/fork-supersedes.ts";
import {
  runCommand,
  SystemCommandRunner,
  SystemGit,
  type CwdCommandRunner,
} from "./lib/fork-command.ts";

export const LEDGER_PATH = "docs/fork/internals/fork-delta.md";

export const LIVE_SCAN_TARGET = "upstream/main";

// The default scan target is a moving remote-tracking ref, not a pin: a bare
// run watches live upstream while CI's blocking gate pins --target to the
// merge base. A failure against the live ref is deferred rebase-time debt,
// never a defect on this head (RSI-Software/t3code-hyprws#1129).

const RECORD_SEPARATOR = "";

export interface ScanOptions {
  // null resolves to the merge base of head and target: the upstream commit the
  // fork stack currently sits on.
  readonly base: string | null;
  readonly head: string;
  readonly target: string;
  readonly typecheck: boolean;
  // The CI job passes both on every run; the overlap report covers the whole
  // range regardless of either.
  readonly since: string | null;
  readonly replayOf: string | null;
}

export interface ScanRange {
  readonly base: string;
  readonly head: string;
  readonly target: string;
}

export interface DomainScan {
  readonly domain: string;
  readonly commitCount: number;
  readonly sharedCount: number;
  readonly gaps: ReadonlyArray<string>;
}

export interface ScanOverlap {
  readonly path: string;
  readonly domain: string;
  readonly covered: boolean;
}

export interface TypecheckGap {
  readonly workspace: string;
  readonly path: string;
}

export interface ScanResult {
  readonly range: ScanRange;
  readonly domains: ReadonlyArray<DomainScan>;
  readonly overlaps: ReadonlyArray<ScanOverlap>;
  readonly typecheckGaps: ReadonlyArray<TypecheckGap>;
  readonly undeclaredDomains: ReadonlyArray<string>;
  readonly untaggedCommits: ReadonlyArray<string>;
  // Steps 2-3 (fork:ci steps 2-3): the hook guard (marked insertions only)
  // and the `replaced-export` / `upstream-test` authoring findings, scoped
  // by `--since` to the commits one change introduces. Historical range
  // stays advisory.
  readonly warnings: ReadonlyArray<ScanAuthoringWarning>;
  readonly hookDetails: ReadonlyArray<string>;
  // Step 1: the additive gate (files, migrations, tests intact). Read from
  // the scan's own range so the gate runs everywhere the scan runs —
  // including the CI `Fork rebase scan` step, which invokes `fork:scan`
  // directly and never `fork:ci`.
  readonly additive: ReadonlyArray<AdditiveFinding>;
  // The forkSupersedes declarations (RSI-Software/t3code-hyprws#716):
  // malformed calls and declarations naming an absent upstream file or
  // title, plus the retire candidates whose upstream case adopted the fork
  // behaviour. A named upstream case reads as superseded rather than
  // contradictory; the additive gate consumes that reading.
  readonly supersedes: ReadonlyArray<string>;
  readonly retireCandidates: ReadonlyArray<SituatedDeclaration>;
}

export { UsageError } from "./lib/fork-cli.ts";

const HELP = `Usage: vp run fork:scan [options]

Verify declared fork seams against upstream changes.

Options:
  --base <ref>    Upstream base of the fork stack (default: merge base of head and target)
  --head <ref>    Fork ref to inventory (default: HEAD)
  --target <ref>  Upstream ref to compare against (default: upstream/main)
  --since <ref>   Accepted for the CI job's shape; the report covers the whole range
  --replay-of <ref>
                  Accepted for the CI job's shape; the report covers the whole range
  --no-typecheck  Skip the rehearsed-head typechecks
  -h, --help      Show help

Output is read-only; exit 0 passes, 1 fails, 2 is usage.
Typechecks run only when --head resolves to checkout HEAD; other refs report declarations.

Pre-rebase overlap walk, declarations only:
  vp run fork:scan --head <fork-ref> --target vX.Y.Z --no-typecheck

Rebase rehearsal, gate 3 (silent seams, from the rehearsed worktree):
  vp run fork:scan --target vX.Y.Z
`;

const defaultOptions = (): ScanOptions => ({
  base: null,
  head: "HEAD",
  target: LIVE_SCAN_TARGET,
  typecheck: true,
  since: null,
  replayOf: null,
});

export const parseScanArgs = (argv: ReadonlyArray<string>): ScanOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const valueFlags = new Set(["--base", "--head", "--target", "--since", "--replay-of"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") continue;
    if (argument === "--no-typecheck") {
      if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
      seen.add(argument);
      options.typecheck = false;
      continue;
    }
    if (!valueFlags.has(argument)) throw new UsageError(`unknown option: ${argument}`);
    if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--base") options.base = value;
    else if (argument === "--head") options.head = value;
    else if (argument === "--since") options.since = value;
    else if (argument === "--replay-of") options.replayOf = value;
    else options.target = value;
  }

  if (options.base !== null && options.base.length === 0) {
    throw new UsageError("--base cannot be empty");
  }
  if (options.since !== null && options.since.length === 0) {
    throw new UsageError("--since cannot be empty");
  }
  if (options.replayOf !== null && options.replayOf.length === 0) {
    throw new UsageError("--replay-of cannot be empty");
  }
  if (options.head.length === 0) throw new UsageError("--head cannot be empty");
  if (options.target.length === 0) throw new UsageError("--target cannot be empty");
  return options;
};

// A domain section is `## <domain>` followed by a `### Rebase scan` table. The
// Path column carries one code span per pattern, so a prose cell such as
// "`package.json` scripts block" contributes the path and drops the prose.
const DOMAIN_HEADING = /^## (?<domain>[a-z][a-z0-9-]*)\s*$/;
const CODE_SPAN = /`([^`]+)`/g;

export const parseRebaseScans = (markdown: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const scans = new Map<string, Array<string>>();
  let domain: string | null = null;
  let inScan = false;

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = DOMAIN_HEADING.exec(line);
    if (heading?.groups?.domain !== undefined) {
      domain = heading.groups.domain;
      scans.set(domain, []);
      inScan = false;
      continue;
    }
    if (line.startsWith("## ")) {
      domain = null;
      inScan = false;
      continue;
    }
    if (line.startsWith("### ")) {
      inScan = line.trim() === "### Rebase scan";
      continue;
    }
    if (!inScan || domain === null || !line.startsWith("|")) continue;
    const cell = line.split("|")[1] ?? "";
    if (cell.trim() === "Path" || /^[\s-]*$/.test(cell)) continue;
    for (const match of cell.matchAll(CODE_SPAN)) {
      const pattern = match[1]?.trim() ?? "";
      if (pattern.length > 0) scans.get(domain)?.push(pattern);
    }
  }

  return new Map([...scans].map(([name, patterns]) => [name, [...new Set(patterns)]]));
};

// `**` spans directory separators, `*` stays inside one path segment.
const patternToRegExp = (pattern: string): RegExp => {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
      continue;
    }
    source += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
};

export const matchesScanPattern = (pattern: string, path: string): boolean =>
  patternToRegExp(pattern).test(path);

export const commitFilesArguments = (shas: ReadonlyArray<string>) =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--name-only",
    `--format=${RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

export const parseCommitFiles = (raw: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const files = new Map<string, ReadonlyArray<string>>();
  for (const record of raw.replace(/\r\n/g, "\n").split(RECORD_SEPARATOR)) {
    const [sha = "", ...rest] = record.split("\n");
    if (sha.trim().length === 0) continue;
    files.set(
      sha.trim(),
      rest.map((line) => line.trim()).filter((line) => line.length > 0),
    );
  }
  return files;
};

export interface ScanInput extends ScanRange {
  readonly commits: ReadonlyArray<ForkCommit>;
  readonly filesBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly scans: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly forkChanged: ReadonlySet<string>;
  readonly upstreamChanged: ReadonlySet<string>;
  // Absent when the caller only wants the rebase-scan verdict, as the unit
  // tests and the ledger-only walks do.
  readonly guard?: AuthoringGuardInput | undefined;
  // Step 1 findings, computed by the runner from the scan's own range so
  // unit tests can pass them in directly without a git checkout.
  readonly additive?: ReadonlyArray<AdditiveFinding>;
  // Step 4 findings (RSI-Software/t3code-hyprws#716), likewise injectable:
  // declaration refusals plus undeclared-contradiction findings.
  readonly supersedes?: ReadonlyArray<string>;
  readonly retireCandidates?: ReadonlyArray<SituatedDeclaration>;
}

export interface AuthoringGuardInput {
  readonly commits: ReadonlyArray<AuthoringGuardCommit>;
  readonly filesBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly patchesBySha: ReadonlyMap<string, CommitPatch>;
  readonly upstreamFiles: ReadonlySet<string>;
  readonly upstreamTestFiles: ReadonlySet<string>;
  readonly upstreamTestLines: ReadonlyMap<string, ReadonlySet<string>>;
  // Significant target-tree lines per touched upstream file, for the hook
  // guard's mirror filter (RSI-Software/t3code-hyprws#1207). Absent on
  // inputs built before the map existed; the guard then behaves as before.
  readonly upstreamLines?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
}

export const buildScanResult = (input: ScanInput): ScanResult => {
  const touched = new Map<string, Set<string>>();
  const commitCounts = new Map<string, number>();
  const untaggedCommits: Array<string> = [];

  for (const commit of input.commits) {
    if (commit.domain === undefined) {
      untaggedCommits.push(commit.short);
      continue;
    }
    commitCounts.set(commit.domain, (commitCounts.get(commit.domain) ?? 0) + 1);
    const paths = touched.get(commit.domain) ?? new Set<string>();
    for (const path of input.filesBySha.get(commit.sha) ?? []) paths.add(path);
    touched.set(commit.domain, paths);
  }

  const domains: Array<DomainScan> = [];
  const overlaps: Array<ScanOverlap> = [];
  const undeclaredDomains: Array<string> = [];

  for (const [domain, paths] of [...touched].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const patterns = input.scans.get(domain);
    if (patterns === undefined) {
      undeclaredDomains.push(domain);
      continue;
    }
    // A file only the fork changed cannot merge two intents, so only the files
    // upstream also changed on the way to the target have to be listed. Both
    // sides are net diffs against the base: a file an intermediate fork commit
    // touched and a later one reverted carries no fork delta to preserve. The
    // commits still decide which domain owns the file. The overlap definition
    // lives in lib/fork-overlap.ts, shared with `fork:delta --inventory`.
    const shared = overlapPaths(paths, input.forkChanged, input.upstreamChanged);
    const covers = (path: string) => patterns.some((pattern) => matchesScanPattern(pattern, path));
    domains.push({
      domain,
      commitCount: commitCounts.get(domain) ?? 0,
      sharedCount: shared.length,
      gaps: shared.filter((path) => !covers(path)),
    });
    for (const path of shared) overlaps.push({ path, domain, covered: covers(path) });
  }

  return {
    range: { base: input.base, head: input.head, target: input.target },
    domains,
    overlaps: overlaps.toSorted((left, right) => left.path.localeCompare(right.path)),
    typecheckGaps: [],
    undeclaredDomains,
    untaggedCommits,
    warnings: input.guard === undefined ? [] : collectAuthoringWarnings(input.guard),
    additive: input.additive ?? [],
    supersedes: input.supersedes ?? [],
    retireCandidates: input.retireCandidates ?? [],
    hookDetails:
      input.guard === undefined
        ? []
        : input.guard.commits.flatMap((commit) => {
            const patch = input.guard?.patchesBySha.get(commit.sha);
            if (patch === undefined) return [];
            return hookGuardWarnings({
              commit,
              files: input.guard?.filesBySha.get(commit.sha) ?? [],
              changedLines: patch.changedLines,
              upstreamFiles: input.guard?.upstreamFiles ?? new Set(),
              upstreamLines: input.guard?.upstreamLines,
            }).map((detail) => `${commit.short}  ${commit.domain}  ${detail}`);
          }),
  };
};

export const scanFailures = (result: ScanResult): ReadonlyArray<string> => [
  ...result.undeclaredDomains.map(
    (domain) => `${domain}: no domain section with a rebase scan in ${LEDGER_PATH}`,
  ),
  ...result.domains.flatMap((domain) =>
    domain.gaps.map((path) => `${domain.domain}: rebase scan omits ${path}`),
  ),
  ...result.typecheckGaps.map(
    (gap) => `typecheck: fork-owned file fails on rehearsed head: ${gap.path}`,
  ),
  ...result.additive.map(
    (finding) => `additive:${finding.check}: ${finding.path}: ${finding.detail}`,
  ),
  ...result.supersedes.map((refusal) => `supersedes: ${refusal}`),
  ...result.warnings.map(
    (warning) => `${warning.rule}: ${warning.commit} ${warning.domain}: ${warning.detail}`,
  ),
  ...result.hookDetails.map((detail) => `hook-guard: ${detail}`),
];

// The two gap classes need different repairs: a ledger gap is an entry the human adds, and a
// typecheck gap is a silent seam the walk fixes in its appended `Fork-Repair` commit. No replayed
// fork commit is ever amended, so the summary must never send the operator back into one.
export const scanFailureSummary = (result: ScanResult): ReadonlyArray<string> => {
  const summary: Array<string> = [];
  const ledgerGaps =
    result.undeclaredDomains.length +
    result.domains.reduce((count, domain) => count + domain.gaps.length, 0);
  if (ledgerGaps > 0) {
    if (result.range.target === LIVE_SCAN_TARGET) {
      summary.push(
        `failed: ${ledgerGaps} rebase-scan gap(s): target ${result.range.target} is a live ref (upstream moved past base ${result.range.base.slice(0, 7)}); deferred rebase-time debt for the next rebase, not a defect on this head; record each path in its domain's Rebase scan table in ${LEDGER_PATH} at rebase time`,
      );
      summary.push(
        `blocking gate pins the merge base instead: vp run fork:scan --head ${result.range.head} --target "$(git merge-base ${result.range.target} ${result.range.head})" --no-typecheck`,
      );
    } else {
      summary.push(
        `failed: ${ledgerGaps} rebase-scan gap(s); add each path to its domain's Rebase scan table in ${LEDGER_PATH}`,
      );
    }
  }
  if (result.typecheckGaps.length > 0) {
    summary.push(
      `failed: ${result.typecheckGaps.length} typecheck gap(s); fix each in the fork commit that owns the file and rerun; never amend a replayed fork commit`,
    );
  }
  return summary;
};

export const renderScanReport = (result: ScanResult): string => {
  const lines: Array<string> = [
    `Fork ${result.range.base}..${result.range.head} against upstream ${result.range.base}..${result.range.target}.`,
  ];
  if (result.overlaps.length === 0) {
    lines.push(`No fork file overlaps ${result.range.target}.`);
  } else {
    lines.push("", "Shared files:");
    for (const overlap of result.overlaps) {
      lines.push(
        `  ${overlap.covered ? "in scan" : "MISSING"}  ${overlap.domain}  ${overlap.path}`,
      );
    }
    lines.push("");
  }
  for (const domain of result.domains) {
    lines.push(
      `${domain.domain}: ${domain.commitCount} commit(s), ${domain.sharedCount} shared file(s), ${domain.gaps.length} gap(s)`,
    );
  }
  if (result.typecheckGaps.length > 0) {
    lines.push("", "Fork-owned typecheck gaps:");
    for (const gap of result.typecheckGaps)
      lines.push(`  TYPECHECK  ${gap.workspace}  ${gap.path}`);
  }
  lines.push(...renderAuthoringWarnings(result.warnings));
  if (result.supersedes.length > 0) {
    lines.push("", `Supersedes, ${result.supersedes.length} finding(s):`);
    for (const refusal of result.supersedes) lines.push(`  SUPERSEDES  ${refusal}`);
  }
  if (result.retireCandidates.length > 0) {
    lines.push("", `Retire candidates, ${result.retireCandidates.length}:`);
    for (const candidate of result.retireCandidates)
      lines.push(
        `  RETIRE  ${candidate.sibling}: forkSupersedes names "${candidate.upstreamTitle}" in ${candidate.upstreamPath}, which now carries the fork behaviour; delete the declaration and its sibling case in the same change`,
      );
  }
  if (result.additive.length > 0) {
    lines.push(...renderAdditiveFindings(result.additive).map((line) => `  ${line}`));
  }
  if (result.hookDetails.length > 0) {
    lines.push("", `Hook guard, ${result.hookDetails.length} finding(s):`);
    for (const detail of result.hookDetails) lines.push(`  HOOK  ${detail}`);
  }
  if (result.untaggedCommits.length > 0) {
    lines.push(
      `skipped ${result.untaggedCommits.length} commit(s) without Fork-Domain (vp run fork:delta --check owns them): ${result.untaggedCommits.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

export interface GitReader {
  readonly run: (args: ReadonlyArray<string>) => string;
}

const readLines = (raw: string): ReadonlyArray<string> =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const readChangedPaths = (git: GitReader, base: string, head: string): ReadonlyArray<string> =>
  readLines(git.run(["-c", "core.quotePath=false", "diff", "--name-only", `${base}..${head}`]));

export interface TypecheckCommand {
  readonly workspace: string;
  readonly packageName: string;
}

export interface TypecheckCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type TypecheckRunner = (root: string, command: TypecheckCommand) => TypecheckCommandResult;

// Every typecheck-capable workspace the fork delta touches. A workspace missing here is a
// workspace whose silent seams the rehearsal cannot see, so add one whenever the delta grows.
const TYPECHECK_COMMANDS: ReadonlyArray<TypecheckCommand> = [
  { workspace: "apps/web", packageName: "@t3tools/web" },
  { workspace: "apps/server", packageName: "t3" },
  { workspace: "apps/desktop", packageName: "@t3tools/desktop" },
  { workspace: "apps/mobile", packageName: "@t3tools/mobile" },
  { workspace: "packages/contracts", packageName: "@t3tools/contracts" },
  { workspace: "packages/client-runtime", packageName: "@t3tools/client-runtime" },
  { workspace: "packages/shared", packageName: "@t3tools/shared" },
];

const systemTypecheckRunner: TypecheckRunner = (root, command) =>
  runCommand("vp", ["run", "--filter", command.packageName, "typecheck"], { cwd: root });

const TYPECHECK_FILE = /^(?<path>.+?)\(\d+,\d+\):\s+error TS\d+:/;

const normalizeTypecheckPath = (root: string, workspace: string, path: string): string | null => {
  const absoluteRoot = NodePath.resolve(root);
  if (NodePath.isAbsolute(path)) {
    const relative = NodePath.relative(absoluteRoot, path);
    if (relative.startsWith(`..${NodePath.sep}`) || relative === "..") return null;
    return relative.split(NodePath.sep).join("/");
  }
  const normalized = path.replace(/^\.\//, "");
  const repoRooted = /^(?:apps|packages)\//.test(normalized);
  return repoRooted ? normalized : `${workspace}/${normalized}`;
};

export const findForkOwnedTypecheckGaps = (
  root: string,
  forkOwned: ReadonlySet<string>,
  runner: TypecheckRunner = systemTypecheckRunner,
): ReadonlyArray<TypecheckGap> => {
  const gaps = new Map<string, TypecheckGap>();
  for (const command of TYPECHECK_COMMANDS) {
    const result = runner(root, command);
    if (result.error !== undefined || result.status === null) {
      throw new Error(
        `${command.packageName} typecheck failed to run: ${result.error?.message ?? "no exit status"}`,
      );
    }
    if (result.status === 0) continue;
    for (const line of `${result.stdout}\n${result.stderr}`.replace(/\r\n/g, "\n").split("\n")) {
      const path = TYPECHECK_FILE.exec(line)?.groups?.path;
      if (path === undefined) continue;
      const normalized = normalizeTypecheckPath(root, command.workspace, path);
      if (normalized !== null && forkOwned.has(normalized)) {
        gaps.set(normalized, { workspace: command.workspace, path: normalized });
      }
    }
  }
  return [...gaps.values()].toSorted((left, right) => left.path.localeCompare(right.path));
};

export const resolveRange = (git: GitReader, options: ScanOptions): ScanRange => ({
  base: options.base ?? git.run(["merge-base", options.target, options.head]).trim(),
  head: options.head,
  target: options.target,
});

// The guard rules read one patch per warned commit, so `--since` is what
// keeps a pull request's run proportional to the commits it adds: only
// commits after the trunk tip the change branched from are enforced, and
// `--replay-of` is accepted for the CI job's shape but never treated as a
// replay signal here.
export const resolveGuardedCommits = (
  git: GitReader,
  options: ScanOptions,
  range: ScanRange,
  commits: ReadonlyArray<ForkCommit>,
): ReadonlyArray<ForkCommit> => {
  const since = options.since;
  const warned =
    since === null ? null : new Set(readLines(git.run(["rev-list", `${since}..${range.head}`])));
  return commits.filter(
    (commit) => commit.domain !== undefined && (warned === null || warned.has(commit.sha)),
  );
};

const buildGuardInput = (
  git: GitReader,
  options: ScanOptions,
  range: ScanRange,
  commits: ReadonlyArray<ForkCommit>,
  filesBySha: ReadonlyMap<string, ReadonlyArray<string>>,
): AuthoringGuardInput | undefined => {
  const guarded = resolveGuardedCommits(git, options, range, commits);
  const guardCommits = guarded.flatMap((commit) =>
    commit.domain === undefined
      ? []
      : [
          {
            sha: commit.sha,
            short: commit.short,
            domain: commit.domain,
            ...(commit.tier === undefined ? {} : { tier: commit.tier }),
            ...(commit.upstreamable === undefined ? {} : { upstreamable: commit.upstreamable }),
          },
        ],
  );
  const patchesBySha =
    guardCommits.length === 0
      ? new Map<string, CommitPatch>()
      : parseCommitPatches(git.run(commitPatchArguments(guardCommits.map(({ sha }) => sha))));
  const upstreamFiles =
    guardCommits.length === 0
      ? new Set<string>()
      : new Set(
          readLines(
            git.run(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", range.base]),
          ),
        );
  const upstreamTestFiles =
    guardCommits.length === 0
      ? new Set<string>()
      : new Set(
          readLines(
            git.run(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", range.target]),
          ),
        );
  return {
    commits: guardCommits,
    filesBySha,
    patchesBySha,
    upstreamFiles,
    upstreamTestFiles,
    upstreamTestLines: readUpstreamLines(
      git,
      range.target,
      patchesBySha,
      upstreamTestFiles,
      (patch) => patch.removedTestLines.keys(),
      () => true,
    ),
    upstreamLines: readUpstreamLines(
      git,
      range.target,
      patchesBySha,
      upstreamFiles,
      (patch) => patch.changedLines.keys(),
      (path) =>
        MARKER_CAPABLE_PATH.test(path) &&
        !GENERATED_HOOK_PATH.test(path) &&
        !upstreamTestFiles.has(path),
    ),
  };
};

/**
 * The target-tree text of every upstream file a warned commit touches —
 * nothing else, so a scan stays proportional to the commits it warns about.
 * One reader serves both rules that measure a patch against the target:
 * upstream-test selects the removed test lines, the hook guard the changed
 * lines of marker-capable source. Without the test side the append-only
 * rule would also refuse the repair it asks for: deleting the fork's own
 * line out of an upstream test file is a removal too. Without the hook
 * side the guard would refuse the repair it cannot name: restoring
 * upstream's own text byte for byte reads as a fork insertion
 * (RSI-Software/t3code-hyprws#1207).
 */
const readUpstreamLines = (
  git: GitReader,
  target: string,
  patchesBySha: ReadonlyMap<string, CommitPatch>,
  upstreamFiles: ReadonlySet<string>,
  selectPaths: (patch: CommitPatch) => Iterable<string>,
  keepPath: (path: string) => boolean,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const paths = new Set<string>();
  for (const patch of patchesBySha.values())
    for (const path of selectPaths(patch)) {
      if (!upstreamFiles.has(path)) continue;
      if (!keepPath(path)) continue;
      paths.add(path);
    }
  const lines = new Map<string, ReadonlySet<string>>();
  for (const path of [...paths].toSorted()) {
    try {
      lines.set(path, significantTestLines(git.run(["show", `${target}:${path}`])));
    } catch {
      // An unreadable blob leaves no entry, and the rule then refuses every removal in that file.
    }
  }
  return lines;
};

/**
 * The supersedes declarations of every fork sibling at the scanned
 * head, judged against the target tree. Siblings are read from the head
 * tree (`show <head>:<path>`), never the working tree, so the check stays
 * proportional to the scan's own refs — including the CI case where the
 * checkout is the synthetic merge commit. A sibling whose counterpart is
 * absent from the head tree is skipped: fork-only tests with no upstream
 * file carry no divergence. An unreadable blob leaves the declaration
 * refused, because an unread tree is not evidence the named case exists.
 */
const readSupersedesAssessment = (
  git: GitReader,
  range: ScanRange,
): {
  readonly supersedes: ReadonlyArray<string>;
  readonly retireCandidates: ReadonlyArray<SituatedDeclaration>;
} => {
  let siblings: ReadonlyArray<string>;
  try {
    siblings = readLines(
      git.run([
        "-c",
        "core.quotePath=false",
        "ls-tree",
        "-r",
        "--name-only",
        range.head,
        "--",
        "apps",
        "packages",
        "scripts",
      ]),
    ).filter((path) => /\.fork\.test\.tsx?$/.test(path));
  } catch {
    return { supersedes: [], retireCandidates: [] };
  }
  if (siblings.length === 0) return { supersedes: [], retireCandidates: [] };
  const siblingTexts = new Map<string, string>();
  for (const sibling of siblings) {
    try {
      siblingTexts.set(sibling, git.run(["show", `${range.head}:${sibling}`]));
    } catch {
      // An unreadable sibling leaves no entry; its declarations stay unread.
    }
  }
  if (siblingTexts.size === 0) return { supersedes: [], retireCandidates: [] };
  // Candidate upstream texts: every counterpart plus every file a
  // declaration names. A named file outside the sibling's counterpart is
  // how a stale declaration surfaces — read it, then let the assessment
  // refuse it.
  const needed = new Set<string>();
  for (const [sibling, text] of siblingTexts) {
    needed.add(sibling.replace(/\.fork\.test\.(tsx?)$/, ".test.$1"));
    for (const call of collectForkSupersedes(text).declarations) needed.add(call.upstreamPath);
  }
  const upstreamTexts = new Map<string, string>();
  for (const path of [...needed].toSorted()) {
    try {
      upstreamTexts.set(path, git.run(["show", `${range.target}:${path}`]));
    } catch {
      // Absent from the target tree: the assessment refuses the naming
      // declaration. No entry is the signal.
    }
  }
  const assessment = assessForkSupersedes(siblingTexts, upstreamTexts);
  return {
    supersedes: [
      ...assessment.refusals,
      ...assessment.undeclared.map(
        ({ sibling, title }) =>
          `${sibling}: case "${title}" contradicts its upstream counterpart with no forkSupersedes declaration; name the upstream case, why the fork differs, and the fork commit`,
      ),
    ],
    retireCandidates: [...assessment.retireCandidates],
  };
};

export const readScan = (
  git: GitReader,
  options: ScanOptions,
  ledger: string,
  additiveRunner?: AdditiveRunner,
): ScanResult => {
  const range = resolveRange(git, options);
  const commits = parseForkLog(git.run(forkLogArguments(range.base, range.head)));
  const shas = commits.flatMap((commit) => (commit.domain === undefined ? [] : [commit.sha]));
  const filesBySha: ReadonlyMap<string, ReadonlyArray<string>> = shas.length === 0
    ? new Map()
    : parseCommitFiles(git.run(commitFilesArguments(shas)));
  return buildScanResult({
    ...range,
    commits,
    filesBySha,
    scans: parseRebaseScans(ledger),
    forkChanged: new Set(readChangedPaths(git, range.base, range.head)),
    upstreamChanged: new Set(readChangedPaths(git, range.base, range.target)),
    guard: buildGuardInput(git, options, range, commits, filesBySha),
    // Base + since, never live upstream: files and migrations read against
    // the pinned base, tests diff head against the since tree so only new
    // loss fires, with upstream-target filtering so removing a fork-added
    // line is free.
    additive:
      additiveRunner === undefined
        ? []
        : checkAdditive(
            additiveRunner,
            additiveRunner.worktree,
            { base: range.base, since: options.since },
            { head: range.head },
          ),
    ...readSupersedesAssessment(git, range),
  });
};

/** What `checkAdditive` needs beyond the git reads: the worktree the trees resolve in. */
export interface AdditiveRunner extends CwdCommandRunner {
  readonly worktree: string;
}

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    const options = parseScanArgs(argv);
    const root = new SystemGit(cwd).run(["rev-parse", "--show-toplevel"]).trim();
    const git = new SystemGit(root);
    const ledger = NodeFS.readFileSync(NodePath.join(root, LEDGER_PATH), "utf8");
    const workingHead = git.run(["rev-parse", "HEAD"]).trim();
    const scannedHead = git.run(["rev-parse", options.head]).trim();
    const typecheckCurrentHead = options.typecheck && workingHead === scannedHead;
    // The additive gate reads git objects (`show <tree>:<path>`,
    // `diff <base> <head>`), never the working tree, so the runner is
    // always available — including the normal CI case, where the checkout
    // is the synthetic merge commit and `--head` is the pull-request head.
    const commandRunner = new SystemCommandRunner();
    const additiveRunner: AdditiveRunner = {
      worktree: root,
      run: commandRunner.run.bind(commandRunner),
    };
    const result: ScanResult = {
      ...readScan(git, options, ledger, additiveRunner),
      typecheckGaps: typecheckCurrentHead
        ? findForkOwnedTypecheckGaps(
            root,
            new Set(readChangedPaths(git, resolveRange(git, options).base, options.head)),
          )
        : [],
    };
    process.stdout.write(renderScanReport(result));
    if (!options.typecheck) {
      process.stdout.write("typecheck: skipped (--no-typecheck)\n");
    } else if (!typecheckCurrentHead) {
      process.stdout.write(`typecheck: skipped (working tree is not ${scannedHead.slice(0, 7)})\n`);
    }

    const failures = scanFailures(result);
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    if (failures.length > 0) {
      for (const line of scanFailureSummary(result)) process.stderr.write(`${line}\n`);
      return 1;
    }
    process.stdout.write(
      `ok: ${result.domains.length} domain rebase scans cover every shared file their commits touch\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`failed: ${message}\n`);
    return 1;
  }
};

export { parseScanArgs as parseArgs };

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
