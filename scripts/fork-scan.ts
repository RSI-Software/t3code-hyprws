#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git check runs before an Effect runtime exists.

// Checks every fork domain's rebase scan against the shared files its own
// commits touch. Shared means the fork changed the file above its upstream base
// and upstream changed it too on the way to the target, which is where a rebase
// silently merges two intents, so the file must be listed in that domain's
// rebase-scan table in docs/internals/fork-delta.md. The target defaults to
// live `upstream/main`; `--target <tag>` pins a release and reproduces the
// automerged-overlap walk gate 3 of the fork-sync skill used to do by hand.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { forkLogArguments, parseForkLog, type ForkCommit } from "./fork-delta.ts";
import { UsageError } from "./lib/fork-cli.ts";
import { CHURN_LEDGER_FILE, CHURN_REF, readBotRefFile } from "./lib/fork-bot-refs.ts";
import { runCommand, SystemGit } from "./lib/fork-command.ts";
import {
  readWorkflowDrift,
  WORKFLOW_REVIEWS_PATH,
  type WorkflowDrift,
} from "./lib/fork-workflow-drift.ts";
import {
  ADOPTED_AUTHORING_GUARDS,
  collectScanWarnings,
  commitPatchArguments,
  parseCommitPatches,
  readHotSeams,
  renderScanWarnings,
  type GuardInput,
  type ScanWarning,
} from "./fork-scan-guards.ts";

export const LEDGER_PATH = "docs/internals/fork-delta.md";
export const CHURN_PATH = "docs/internals/fork-churn.json";

const RECORD_SEPARATOR = "";

export interface ScanOptions {
  // null resolves to the merge base of head and target: the upstream commit the
  // fork stack currently sits on.
  readonly base: string | null;
  readonly head: string;
  readonly target: string;
  readonly typecheck: boolean;
  // Ledger guards warn about commits after this ref only, so a pull request
  // sees the shapes it introduces rather than the whole replayed stack.
  readonly since: string | null;
  readonly strict: boolean;
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
  readonly warnings: ReadonlyArray<ScanWarning>;
  readonly workflowDrift: ReadonlyArray<WorkflowDrift>;
}

export { UsageError } from "./lib/fork-cli.ts";

const HELP = `Usage: vp run fork:scan [options]

Verify every fork domain's rebase scan lists the shared files its own commits touch:
the files the fork changed above its upstream base that upstream changed as well.

Options:
  --base <ref>    Upstream base of the fork stack (default: merge base of head and target)
  --head <ref>    Fork ref to inventory (default: HEAD)
  --target <ref>  Upstream ref to compare against (default: upstream/main)
  --since <ref>   Warn only about commits after <ref> (default: every commit in the range)
  --strict        Fail on ledger guard warnings as well as scan gaps
  --no-typecheck  Skip the rehearsed-head typechecks
  -h, --help      Show help

Ledger guards read refs/fork/churn, or docs/internals/fork-churn.json until it is seeded,
and warn about a hot seam, a fork test block appended to an upstream-owned test file, a
commit spread over more than six upstream files, and an upstream export a commit deletes
and re-declares. They print and exit 0 so an
existing walk keeps its verdict; --strict turns them into a failure. With --since,
adopted authoring guards (terminal-attachment-boundary, upstream-test) fail without --strict.
Test ownership follows the selected target, including independently added same-path tests.

Workflow copies require a reviewed adaptation or no-change decision in
.github/fork-workflow-reviews.json. Changed upstream or fork blobs fail even without
--strict, including after replay. Output is read-only; exit 0 passes, 1 fails, 2 is usage.

The typechecks run only when --head resolves to the checkout HEAD, because they read the
working tree. A scan of any other ref reports declarations alone.

Pre-rebase overlap walk, declarations only:
  vp run fork:scan --head <fork-ref> --target vX.Y.Z --no-typecheck

Rebase rehearsal, gate 3 (silent seams, from the rehearsed worktree):
  vp run fork:scan --target vX.Y.Z
`;

const defaultOptions = (): ScanOptions => ({
  base: null,
  head: "HEAD",
  target: "upstream/main",
  typecheck: true,
  since: null,
  strict: false,
});

export const parseScanArgs = (argv: ReadonlyArray<string>): ScanOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const valueFlags = new Set(["--base", "--head", "--target", "--since"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") continue;
    if (argument === "--no-typecheck" || argument === "--strict") {
      if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
      seen.add(argument);
      if (argument === "--strict") options.strict = true;
      else options.typecheck = false;
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
    else options.target = value;
  }

  if (options.base !== null && options.base.length === 0) {
    throw new UsageError("--base cannot be empty");
  }
  if (options.since !== null && options.since.length === 0) {
    throw new UsageError("--since cannot be empty");
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
  readonly guard?: GuardInput;
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
    // commits still decide which domain owns the file.
    const shared = [...paths]
      .filter((path) => input.forkChanged.has(path) && input.upstreamChanged.has(path))
      .toSorted();
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
    warnings: input.guard === undefined ? [] : collectScanWarnings(input.guard),
    workflowDrift: [],
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
  ...result.workflowDrift.flatMap((drift) =>
    drift.problem === undefined
      ? []
      : [`workflow-drift: ${drift.upstream} -> ${drift.fork}: ${drift.problem}`],
  ),
];

// The two gap classes need different repairs: a ledger gap is an entry the human adds, and a
// typecheck gap is a silent seam fixed in the fork commit that owns the file.
export const scanFailureSummary = (result: ScanResult): ReadonlyArray<string> => {
  const summary: Array<string> = [];
  const ledgerGaps =
    result.undeclaredDomains.length +
    result.domains.reduce((count, domain) => count + domain.gaps.length, 0);
  if (ledgerGaps > 0) {
    summary.push(
      `failed: ${ledgerGaps} rebase-scan gap(s); add each path to its domain's Rebase scan table in ${LEDGER_PATH}`,
    );
  }
  if (result.typecheckGaps.length > 0) {
    summary.push(
      `failed: ${result.typecheckGaps.length} typecheck gap(s); fix each as a silent seam in the fork commit that owns the file, then rerun`,
    );
  }
  const workflowGaps = result.workflowDrift.filter(({ problem }) => problem !== undefined).length;
  if (workflowGaps > 0)
    summary.push(
      `failed: ${workflowGaps} workflow drift gap(s); adapt the fork copy or justify no-change in ${WORKFLOW_REVIEWS_PATH}, then rerun`,
    );
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
  lines.push(...renderScanWarnings(result.warnings));
  if (result.workflowDrift.length > 0) {
    lines.push("", "Workflow copy reviews:");
    for (const drift of result.workflowDrift) {
      lines.push(
        `  ${drift.problem === undefined ? drift.review?.disposition : "MISSING"}  ${drift.upstream} -> ${drift.fork}`,
      );
      lines.push(`    upstream ${drift.upstreamBlob}; fork ${drift.forkBlob}`);
      lines.push(`    ${drift.problem ?? drift.review?.reason}`);
    }
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

// The guard rules read one patch per warned commit, so `--since` is what keeps
// a pull request's run proportional to the commits it adds.
const buildGuardInput = (
  git: GitReader,
  options: ScanOptions,
  range: ScanRange,
  commits: ReadonlyArray<ForkCommit>,
  filesBySha: ReadonlyMap<string, ReadonlyArray<string>>,
  churn: string | null,
): GuardInput => {
  const warned =
    options.since === null
      ? null
      : new Set(readLines(git.run(["rev-list", `${options.since}..${range.head}`])));
  const guardCommits = commits.flatMap((commit) =>
    commit.domain === undefined || (warned !== null && !warned.has(commit.sha))
      ? []
      : [{ sha: commit.sha, short: commit.short, domain: commit.domain }],
  );
  return {
    commits: guardCommits,
    filesBySha,
    patchesBySha:
      guardCommits.length === 0
        ? new Map()
        : parseCommitPatches(git.run(commitPatchArguments(guardCommits.map(({ sha }) => sha)))),
    upstreamFiles:
      guardCommits.length === 0
        ? new Set()
        : new Set(
            readLines(
              git.run(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", range.base]),
            ),
          ),
    hotSeams: churn === null ? new Map() : readHotSeams(churn),
    upstreamTestFiles:
      guardCommits.length === 0
        ? new Set()
        : new Set(
            readLines(
              git.run(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", range.target]),
            ),
          ),
  };
};

export const readScan = (
  git: GitReader,
  options: ScanOptions,
  ledger: string,
  churn: string | null = null,
): ScanResult => {
  const range = resolveRange(git, options);
  const commits = parseForkLog(git.run(forkLogArguments(range.base, range.head)));
  const shas = commits.flatMap((commit) => (commit.domain === undefined ? [] : [commit.sha]));
  const filesBySha: ReadonlyMap<string, ReadonlyArray<string>> = shas.length === 0
    ? new Map()
    : parseCommitFiles(git.run(commitFilesArguments(shas)));
  const result = buildScanResult({
    ...range,
    commits,
    filesBySha,
    scans: parseRebaseScans(ledger),
    forkChanged: new Set(readChangedPaths(git, range.base, range.head)),
    upstreamChanged: new Set(readChangedPaths(git, range.base, range.target)),
    guard: buildGuardInput(git, options, range, commits, filesBySha, churn),
  });
  return { ...result, workflowDrift: readWorkflowDrift(git, range.head, range.target) };
};

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
    // The ledger lives on its bot-owned ref; the deprecated file answers until it is seeded.
    const churnPath = NodePath.join(root, CHURN_PATH);
    const churn =
      readBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE) ??
      (NodeFS.existsSync(churnPath) ? NodeFS.readFileSync(churnPath, "utf8") : null);
    const scanned = readScan(git, options, ledger, churn);
    const workingHead = git.run(["rev-parse", "HEAD"]).trim();
    const scannedHead = git.run(["rev-parse", options.head]).trim();
    const typecheckCurrentHead = options.typecheck && workingHead === scannedHead;
    const result: ScanResult = {
      ...scanned,
      typecheckGaps: typecheckCurrentHead
        ? findForkOwnedTypecheckGaps(
            root,
            new Set(readChangedPaths(git, scanned.range.base, scanned.range.head)),
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
    if (result.warnings.length > 0) {
      const adoptedFailures =
        options.since === null
          ? []
          : result.warnings.filter(({ rule }) => ADOPTED_AUTHORING_GUARDS.has(rule));
      if (!options.strict && adoptedFailures.length > 0) {
        process.stdout.write(
          `failed: ${adoptedFailures.length} adopted authoring guard warning(s) in --since range; repair the named fork boundary\n`,
        );
        return 1;
      }
      process.stdout.write(
        options.strict
          ? `failed: ${result.warnings.length} ledger guard warning(s) under --strict\n`
          : `warned: ${result.warnings.length} ledger guard warning(s); advisory, --strict fails on them\n`,
      );
      if (options.strict) return 1;
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
