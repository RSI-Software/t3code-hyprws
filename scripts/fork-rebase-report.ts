#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git report runs before an Effect runtime exists.

// Generates the repository orientation used before a hyprws upstream rebase.
// The report is derived only from Git refs and commit metadata: unchanged refs
// produce byte-identical Markdown and JSON.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import { SystemGit } from "./lib/fork-command.ts";

import {
  CONVENTIONAL_TYPE_ORDER,
  encodeReportJson,
  renderMarkdown,
} from "./fork-rebase-report-render.ts";

export {
  collapseAliasNodes,
  encodeReportJson,
  renderMarkdown,
  renderRetireCandidates,
  renderStateGraph,
} from "./fork-rebase-report-render.ts";
export { SystemGit } from "./lib/fork-command.ts";
import {
  buildFeasibility,
  parseMergeTreeResult,
  readForkStack,
  type FeasibilityGit,
  type ForkRebaseFeasibility,
  type GitCommandResult,
} from "./lib/fork-rebase-feasibility.ts";
import {
  EMPTY_RETIREMENT_LEDGER,
  readForkRetirementLedger,
  retirementDecision,
  type ForkRetirementLedger,
  type RetirementDecision,
} from "./lib/fork-retirement-ledger.ts";

export const DEFAULT_JSON_PATH = "docs/internals/generated/fork-rebase-report.json";
export const DEFAULT_MARKDOWN_PATH = "docs/internals/generated/fork-rebase-report.md";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";

export interface ReportCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly type: string | null;
}

export interface ReportRepository {
  readonly slug: string | null;
  readonly webUrl: string | null;
}

export interface ReportRelease {
  readonly tag: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly commitsSincePrevious: ReadonlyArray<ReportCommit>;
}

export interface ReportLane {
  readonly ref: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly repository: ReportRepository;
  readonly commitCount: number;
  readonly changeTypes: Readonly<Record<string, number>>;
  readonly releases: ReadonlyArray<ReportRelease>;
  readonly unreleasedCommits: ReadonlyArray<ReportCommit>;
}

export interface RetireSignal {
  readonly kind: "already-upstream" | "behaviour-overlap";
  readonly evidence: string;
}

export interface RetireCandidate {
  readonly commit: string;
  readonly subject: string;
  readonly domain: string | null;
  readonly tier: string | null;
  readonly signals: ReadonlyArray<RetireSignal>;
  readonly decision: RetirementDecision;
  readonly reason?: string;
}

export interface ForkRebaseReport {
  readonly schemaVersion: 3;
  readonly generatedBy: "vp run fork:rebase-report";
  readonly sharedBase: {
    readonly sha: string;
    readonly shortSha: string;
    readonly upstreamTags: ReadonlyArray<string>;
  };
  readonly upstream: ReportLane;
  readonly hyprws: ReportLane;
  readonly feasibility: ForkRebaseFeasibility;
  readonly retireCandidates: ReadonlyArray<RetireCandidate>;
}

export interface ReportOptions {
  readonly source: string;
  readonly target: string;
  readonly jsonOut: string;
  readonly markdownOut: string;
  readonly fetch: boolean;
  readonly check: boolean;
}

export interface GitReader extends FeasibilityGit {}

const HELP = `Usage: vp run fork:rebase-report [options]

Generate the Git orientation snapshot used before rebasing hyprws.

Options:
  --source <ref>         Fork ref (default: origin/hyprws)
  --target <ref>         Upstream ref (default: upstream/main)
  --json-out <path>      JSON path relative to repo root
  --markdown-out <path>  Markdown path relative to repo root
  --fetch                Fetch both remote refs and tags first
  --check                Exit 1 instead of writing when outputs are stale
  -h, --help             Show help
  -V, --version          Show schema version

Manual update:
  vp run fork:rebase-report --fetch
`;

const defaultOptions = (): ReportOptions => ({
  source: "origin/hyprws",
  target: "upstream/main",
  jsonOut: DEFAULT_JSON_PATH,
  markdownOut: DEFAULT_MARKDOWN_PATH,
  fetch: false,
  check: false,
});

const updateCommand = (options: ReportOptions): string => {
  const defaults = defaultOptions();
  const args: Array<string> = [];
  if (options.source !== defaults.source) args.push("--source", options.source);
  if (options.target !== defaults.target) args.push("--target", options.target);
  if (options.jsonOut !== defaults.jsonOut) args.push("--json-out", options.jsonOut);
  if (options.markdownOut !== defaults.markdownOut) {
    args.push("--markdown-out", options.markdownOut);
  }
  if (remoteFromRef(options.source) !== null && remoteFromRef(options.target) !== null) {
    args.push("--fetch");
  }
  return ["vp run fork:rebase-report", ...args].join(" ");
};

export { UsageError } from "./lib/fork-cli.ts";

export const parseReportArgs = (argv: ReadonlyArray<string>): ReportOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const valueFlags = new Set(["--source", "--target", "--json-out", "--markdown-out"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (
      argument === "-h" ||
      argument === "--help" ||
      argument === "-V" ||
      argument === "--version"
    ) {
      continue;
    }
    if (argument === "--fetch" || argument === "--check") {
      if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
      seen.add(argument);
      if (argument === "--fetch") options.fetch = true;
      else options.check = true;
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
    if (argument === "--source") options.source = value;
    else if (argument === "--target") options.target = value;
    else if (argument === "--json-out") options.jsonOut = value;
    else options.markdownOut = value;
  }

  if (options.source.length === 0) throw new UsageError("--source cannot be empty");
  if (options.target.length === 0) throw new UsageError("--target cannot be empty");
  if (options.jsonOut === options.markdownOut) {
    throw new UsageError("--json-out and --markdown-out must be different paths");
  }
  return options;
};

export { parseReportArgs as parseArgs };

export const classifyChangeType = (subject: string): string | null => {
  const match = /^(?<type>[a-z][a-z0-9-]*)(?:\([^)]*\))?!?:\s/.exec(subject);
  return match?.groups?.type ?? null;
};

export const parseCommitLog = (raw: string): ReadonlyArray<ReportCommit> =>
  raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const separator = record.indexOf(FIELD_SEPARATOR);
      if (separator === -1) throw new Error("git log returned a malformed record");
      const sha = record.slice(0, separator);
      const subject = record.slice(separator + 1).replace(/\n+$/, "");
      return {
        sha,
        shortSha: sha.slice(0, 7),
        subject,
        type: classifyChangeType(subject),
      };
    });

const readCommits = (
  git: GitReader,
  startSha: string,
  endSha: string,
): ReadonlyArray<ReportCommit> => {
  if (startSha === endSha) return [];
  return parseCommitLog(
    git.run([
      "log",
      "--reverse",
      "--topo-order",
      `--format=%H${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
      `${startSha}..${endSha}`,
    ]),
  );
};

export const canonicalRepository = (remoteUrl: string): ReportRepository => {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { slug: null, webUrl: null };
    }
    const path = url.pathname.replace(/^\//, "");
    const webUrl = `${url.protocol}//${url.host}/${path}`;
    return { slug: url.host === "github.com" ? path : null, webUrl };
  } catch {
    const scp = /^(?:[^@/\s]+@)?(?<host>[^:/\s]+):(?<path>[^/].+)$/.exec(trimmed);
    if (scp?.groups?.host && scp.groups.path) {
      const webUrl = `https://${scp.groups.host}/${scp.groups.path}`;
      return {
        slug: scp.groups.host === "github.com" ? scp.groups.path : null,
        webUrl,
      };
    }
    return { slug: null, webUrl: null };
  }
};

const remoteFromRef = (ref: string): string | null => {
  const separator = ref.indexOf("/");
  return separator <= 0 ? null : ref.slice(0, separator);
};

const repositoryForRef = (git: GitReader, ref: string): ReportRepository => {
  const remote = remoteFromRef(ref);
  return remote === null
    ? { slug: null, webUrl: null }
    : canonicalRepository(git.run(["remote", "get-url", remote]));
};

const listReachableTags = (
  git: GitReader,
  baseSha: string,
  headSha: string,
  accepts: (tag: string) => boolean,
): ReadonlyArray<{ readonly tag: string; readonly sha: string }> => {
  const candidates = git
    .run([
      "tag",
      "--list",
      "v*",
      "--merged",
      headSha,
      "--contains",
      baseSha,
      "--sort=version:refname",
    ])
    .split("\n")
    .filter((tag) => tag.length > 0 && accepts(tag))
    .map((tag) => ({ tag, sha: git.run(["rev-parse", `${tag}^{commit}`]).trim() }));

  const commitOrder = new Map(
    git
      .run(["rev-list", "--reverse", "--topo-order", `${baseSha}..${headSha}`])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((sha, index) => [sha, index] as const),
  );
  return candidates.toSorted((left, right) => {
    const leftIndex =
      left.sha === baseSha ? -1 : (commitOrder.get(left.sha) ?? Number.MAX_SAFE_INTEGER);
    const rightIndex =
      right.sha === baseSha ? -1 : (commitOrder.get(right.sha) ?? Number.MAX_SAFE_INTEGER);
    return leftIndex - rightIndex;
  });
};

const buildReleases = (
  git: GitReader,
  baseSha: string,
  tags: ReadonlyArray<{ readonly tag: string; readonly sha: string }>,
): ReadonlyArray<ReportRelease> => {
  let previousSha = baseSha;
  return tags.map(({ tag, sha }) => {
    const commitsSincePrevious = readCommits(git, previousSha, sha);
    previousSha = sha;
    return { tag, sha, shortSha: sha.slice(0, 7), commitsSincePrevious };
  });
};

const countChangeTypes = (
  commits: ReadonlyArray<ReportCommit>,
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const type = commit.type ?? "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const known = CONVENTIONAL_TYPE_ORDER.filter((type) => counts.has(type));
  const custom = [...counts.keys()]
    .filter((type) => type !== "other" && !CONVENTIONAL_TYPE_ORDER.includes(type as never))
    .toSorted();
  const keys = [...known, ...custom, ...(counts.has("other") ? ["other"] : [])];
  return Object.fromEntries(keys.map((key) => [key, counts.get(key) ?? 0]));
};

const buildLane = (
  git: GitReader,
  baseSha: string,
  ref: string,
  headSha: string,
  tagFilter: (tag: string) => boolean,
): ReportLane => {
  const releases = buildReleases(git, baseSha, listReachableTags(git, baseSha, headSha, tagFilter));
  const previousSha = releases.at(-1)?.sha ?? baseSha;
  const allCommits = readCommits(git, baseSha, headSha);
  return {
    ref,
    sha: headSha,
    shortSha: headSha.slice(0, 7),
    repository: repositoryForRef(git, ref),
    commitCount: allCommits.length,
    changeTypes: countChangeTypes(allCommits),
    releases,
    unreleasedCommits: readCommits(git, previousSha, headSha),
  };
};

const changedPathsForCommit = (
  git: Pick<GitReader, "run">,
  commit: string,
): ReadonlyArray<string> =>
  git
    .run(["-c", "core.quotePath=false", "diff", "--name-only", "-z", `${commit}^`, commit])
    .split("\0")
    .filter(Boolean)
    .toSorted();

interface HunkRange {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

export const parseAddedHunkRanges = (diff: string): ReadonlyArray<HunkRange> =>
  diff.split("\n").flatMap((line) => {
    const match = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/.exec(line);
    const start = Number(match?.groups?.start);
    const count = match?.groups?.count === undefined ? 1 : Number(match.groups.count);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)) return [];
    const end = count <= 1 ? start : start + count - 1;
    return [
      {
        start,
        end,
        label: count === 0 ? `${start},0` : count === 1 ? `${start}` : `${start}-${end}`,
      },
    ];
  });

const hunkDistance = (left: HunkRange, right: HunkRange): number => {
  if (left.end < right.start) return right.start - left.end;
  if (right.end < left.start) return left.start - right.end;
  return 0;
};

export const buildRetireCandidates = (
  git: GitReader,
  sourceSha: string,
  targetSha: string,
  baseSha: string,
  feasibility: ForkRebaseFeasibility,
  ledger: ForkRetirementLedger,
): ReadonlyArray<RetireCandidate> => {
  const targetTree = git.run(["rev-parse", `${targetSha}^{tree}`]).trim();
  const hardByCommit = new Map<string, Array<string>>();
  for (const conflict of feasibility.conflicts) {
    const evidence = `${conflict.path} (${conflict.hunkCount} ${conflict.hunkCount === 1 ? "hunk" : "hunks"})`;
    const sha = conflict.introducingForkCommit.sha;
    hardByCommit.set(sha, [...(hardByCommit.get(sha) ?? []), evidence]);
  }
  const overlapPaths = new Set([
    ...feasibility.overlap.automerged,
    ...feasibility.conflicts.map((conflict) => conflict.path),
  ]);
  const upstreamHunkCache = new Map<string, ReadonlyArray<HunkRange>>();
  const upstreamHunks = (path: string): ReadonlyArray<HunkRange> => {
    const cached = upstreamHunkCache.get(path);
    if (cached !== undefined) return cached;
    const ranges = parseAddedHunkRanges(
      git.run(["diff", "--no-ext-diff", "--unified=0", baseSha, targetSha, "--", path]),
    );
    upstreamHunkCache.set(path, ranges);
    return ranges;
  };

  return readForkStack(git, sourceSha).flatMap((forkCommit) => {
    const signals: Array<RetireSignal> = [];
    const parent = git.run(["rev-parse", `${forkCommit.sha}^`]).trim();
    const reverse = parseMergeTreeResult(
      targetSha,
      forkCommit.sha,
      git.runResult([
        "-c",
        "core.quotePath=false",
        "merge-tree",
        "--write-tree",
        `--merge-base=${parent}`,
        targetSha,
        forkCommit.sha,
      ]),
    );
    if (reverse.conflicts.length === 0 && reverse.tree === targetTree) {
      signals.push({
        kind: "already-upstream",
        evidence: "the target tree already contains this commit's patch",
      });
    }

    const hard = (hardByCommit.get(forkCommit.sha) ?? []).toSorted();
    const hardPaths = new Set(
      feasibility.conflicts
        .filter((conflict) => conflict.introducingForkCommit.sha === forkCommit.sha)
        .map((conflict) => conflict.path),
    );
    const weak = changedPathsForCommit(git, forkCommit.sha)
      .filter((path) => overlapPaths.has(path) && !hardPaths.has(path))
      .flatMap((path) => {
        const forkHunks = parseAddedHunkRanges(
          git.run([
            "diff",
            "--no-ext-diff",
            "--unified=0",
            `${forkCommit.sha}^`,
            forkCommit.sha,
            "--",
            path,
          ]),
        );
        return forkHunks.flatMap((forkHunk) =>
          upstreamHunks(path).flatMap((upstreamHunk) =>
            hunkDistance(forkHunk, upstreamHunk) <= 3
              ? [`${path}@${forkHunk.label}~${upstreamHunk.label}`]
              : [],
          ),
        );
      });
    if (hard.length > 0 || weak.length > 0) {
      signals.push({
        kind: "behaviour-overlap",
        evidence: [
          ...(hard.length === 0 ? [] : [`hard: ${hard.join(", ")}`]),
          ...(weak.length === 0 ? [] : [`weak hunk overlap: ${weak.join(", ")}`]),
        ].join("; "),
      });
    }
    if (signals.length === 0) return [];
    const recorded = retirementDecision(ledger, forkCommit.subject);
    return [
      {
        commit: forkCommit.sha,
        subject: forkCommit.subject,
        domain: forkCommit.domain,
        tier: forkCommit.tier,
        signals,
        decision: recorded.decision,
        ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
      },
    ];
  });
};

export const buildReport = (
  git: GitReader,
  source: string,
  target: string,
  retirementLedger: ForkRetirementLedger = EMPTY_RETIREMENT_LEDGER,
): ForkRebaseReport => {
  const sourceSha = git.run(["rev-parse", `${source}^{commit}`]).trim();
  const targetSha = git.run(["rev-parse", `${target}^{commit}`]).trim();
  const baseSha = git.run(["merge-base", sourceSha, targetSha]).trim();
  const isUpstreamRelease = (tag: string) =>
    /^v\d+\.\d+\.\d+(?:$|-)/.test(tag) && !/-hyprws\.\d+$/.test(tag);
  const isForkRelease = (tag: string) => /^v\d+\.\d+\.\d+-hyprws\.\d+$/.test(tag);
  const upstream = buildLane(git, baseSha, target, targetSha, isUpstreamRelease);
  const hyprws = buildLane(git, baseSha, source, sourceSha, isForkRelease);
  const feasibility = buildFeasibility(git, sourceSha, targetSha, baseSha);

  return {
    schemaVersion: 3,
    generatedBy: "vp run fork:rebase-report",
    sharedBase: {
      sha: baseSha,
      shortSha: baseSha.slice(0, 7),
      upstreamTags: upstream.releases
        .filter((release) => release.sha === baseSha)
        .map((release) => release.tag),
    },
    upstream,
    hyprws,
    feasibility,
    retireCandidates: buildRetireCandidates(
      git,
      sourceSha,
      targetSha,
      baseSha,
      feasibility,
      retirementLedger,
    ),
  };
};

const resolveOutput = (root: string, output: string): string => {
  const resolved = NodePath.resolve(root, output);
  const relative = NodePath.relative(root, resolved);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new UsageError(`output path must stay inside the repository: ${output}`);
  }
  return resolved;
};

const writeAtomically = (path: string, contents: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  NodeFS.writeFileSync(temporary, contents, "utf8");
  NodeFS.renameSync(temporary, path);
};

interface ReportOutput {
  readonly relative: string;
  readonly path: string;
  readonly contents: string;
}

const isOnDisk = (output: ReportOutput): boolean =>
  NodeFS.existsSync(output.path) && NodeFS.readFileSync(output.path, "utf8") === output.contents;

const fetchRef = (git: GitReader, ref: string): void => {
  const remote = remoteFromRef(ref);
  if (remote === null) throw new UsageError(`--fetch requires a remote-tracking ref: ${ref}`);
  const branch = ref.slice(remote.length + 1);
  git.run(["fetch", "--prune", "--tags", remote, branch]);
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write("3\n");
    return 0;
  }

  try {
    const options = parseReportArgs(argv);
    const bootstrapGit = new SystemGit(cwd);
    const root = bootstrapGit.run(["rev-parse", "--show-toplevel"]).trim();
    const git = new SystemGit(root);
    if (options.fetch) {
      fetchRef(git, options.source);
      fetchRef(git, options.target);
    }
    const retirementLedger = readForkRetirementLedger(root);
    const report = buildReport(git, options.source, options.target, retirementLedger);
    const outputs: ReadonlyArray<ReportOutput> = [
      {
        relative: options.jsonOut,
        path: resolveOutput(root, options.jsonOut),
        contents: encodeReportJson(report),
      },
      {
        relative: options.markdownOut,
        path: resolveOutput(root, options.markdownOut),
        contents: renderMarkdown(report),
      },
    ];

    if (options.check) {
      const stale = outputs.filter((output) => !isOnDisk(output));
      if (stale.length > 0) {
        for (const output of stale) process.stderr.write(`stale: ${output.relative}\n`);
        process.stderr.write(`run: ${updateCommand(options)}\n`);
        return 1;
      }
      process.stdout.write("current: fork rebase report\n");
      return 0;
    }

    for (const output of outputs) {
      // Unchanged refs render byte-identical output; leave the file and its
      // mtime alone so `updated:` only ever reports a real change.
      if (isOnDisk(output)) {
        process.stdout.write(`unchanged: ${output.relative}\n`);
        continue;
      }
      writeAtomically(output.path, output.contents);
      process.stdout.write(`updated: ${output.relative}\n`);
    }
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

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
