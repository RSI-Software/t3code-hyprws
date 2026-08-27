#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone sweep runs before an Effect runtime exists.

// Resolves the fork's open `upstream-watch` issues against a rebase target.
// Step 0 of the fork sync runbook runs it: every issue that waits on an upstream
// issue or pull request is re-read here, and each linked pull request is checked
// for whether its merge commit is already contained in the target tag.
//
// The sweep is read-only on both repositories. It never posts anywhere, and it
// reads upstream citations only from code spans, so nothing it touches can fire
// a cross-reference event on an upstream thread.

import * as NodeChildProcess from "node:child_process";

const FORK_REPOSITORY = "RSI-Software/t3code-hyprws";
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const WATCH_LABEL = "upstream-watch";
const ISSUE_PAGE_SIZE = 100;
// The sweep walks every page rather than capping the list. A truncated sweep reads
// exactly like a complete one, and this step's whole job is proving that nothing
// waits on upstream unnoticed. Exhausting this bound is a loud failure instead.
const MAX_ISSUE_PAGES = 50;
// The issues endpoint pages by offset over a live set, and it offers no cursor to page
// by instead: `sort` and `direction` still slice the same shifting window. So when an
// issue closes or loses the label mid-walk, every later issue slides back one slot, a
// still-open issue lands on a page the walk already consumed, and the short final page
// still reads like a complete sweep. A multi-page walk therefore repeats until two
// consecutive walks see the same issue numbers, and a set that never settles is a loud
// failure rather than a list a shift could have silently shortened.
const MAX_ISSUE_WALKS = 4;

// A citation is only recognized inside a code span, because a bare `owner/repo#n`
// in an issue body notifies the upstream thread.
const CITATION_PATTERN = /`([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)`/g;

export type WatchStatus =
  | "ready"
  | "pending-tag"
  | "waiting"
  | "dropped"
  | "fix-uncited"
  | "unresolved"
  | "uncited";

// Least advanced first. An issue rolls up to the least advanced of its live citations.
const STATUS_ORDER: ReadonlyArray<WatchStatus> = [
  "uncited",
  "unresolved",
  "fix-uncited",
  "dropped",
  "waiting",
  "pending-tag",
  "ready",
];

// A spent citation can never advance on its own: the upstream item closed without
// leaving a merge commit this sweep can resolve. It reports what the operator must
// do about that citation, but it never holds back a watch whose other citations can
// still land, or the watch deadlocks below `ready` forever.
const SPENT_STATUSES: ReadonlySet<WatchStatus> = new Set<WatchStatus>(["dropped", "fix-uncited"]);

export interface WatchIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
}

export interface Citation {
  readonly slug: string;
  readonly number: number;
}

export interface CitationResult {
  readonly ref: string;
  readonly kind: "pull" | "issue";
  readonly state: string;
  readonly mergeCommit: string | null;
  readonly containedInTarget: boolean | null;
  readonly status: WatchStatus;
  readonly detail: string;
}

export interface IssueResult {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly status: WatchStatus;
  readonly citations: ReadonlyArray<CitationResult>;
}

export interface UpstreamWatchSweep {
  readonly fork: string;
  readonly upstream: string;
  readonly label: string;
  readonly target: string;
  readonly targetSha: string | null;
  readonly issues: ReadonlyArray<IssueResult>;
}

export interface SweepOptions {
  readonly fork: string;
  readonly upstream: string;
  readonly target: string;
  readonly json: boolean;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitReader {
  runResult(args: ReadonlyArray<string>): CommandResult;
}

export interface GitHubReader {
  read(args: ReadonlyArray<string>): CommandResult;
}

const HELP = `Usage: vp run fork:upstream-watch [options]

List the fork's open ${WATCH_LABEL} issues and resolve each cited upstream item
against the rebase target. Read-only: the sweep never posts to either repository.

Options:
  --target <ref>       Upstream ref the sweep resolves against (default: upstream/main)
  --fork <slug>        Fork repository (default: ${FORK_REPOSITORY})
  --upstream <slug>    Upstream repository (default: ${UPSTREAM_REPOSITORY})
  --json               Emit the sweep as JSON
  -h, --help           Show help

Exit codes:
  0  the sweep ran
  1  the sweep could not run
  2  usage error
`;

const defaultOptions = (): SweepOptions => ({
  fork: FORK_REPOSITORY,
  upstream: UPSTREAM_REPOSITORY,
  target: "upstream/main",
  json: false,
});

export class UsageError extends Error {}

export const parseArgs = (argv: ReadonlyArray<string>): SweepOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const valueFlags = new Set(["--target", "--fork", "--upstream"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") continue;
    if (argument === "--json") {
      if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
      seen.add(argument);
      options.json = true;
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
    if (argument === "--target") options.target = value;
    else if (argument === "--fork") options.fork = value;
    else options.upstream = value;
  }

  if (options.target.length === 0) throw new UsageError("--target cannot be empty");
  if (options.fork.length === 0) throw new UsageError("--fork cannot be empty");
  if (options.upstream.length === 0) throw new UsageError("--upstream cannot be empty");
  return options;
};

export class SystemGit implements GitReader {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  runResult(args: ReadonlyArray<string>): CommandResult {
    const result = NodeChildProcess.spawnSync("git", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

export class SystemGitHub implements GitHubReader {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  read(args: ReadonlyArray<string>): CommandResult {
    const result = NodeChildProcess.spawnSync("gh", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error !== undefined) throw result.error;
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

const readJson = (gh: GitHubReader, args: ReadonlyArray<string>): unknown => {
  const result = gh.read(args);
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} exited with ${result.status}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as unknown;
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const stringField = (value: unknown, key: string): string => {
  const raw = field(value, key);
  return typeof raw === "string" ? raw : "";
};

interface IssueWalk {
  readonly issues: ReadonlyArray<WatchIssue>;
  readonly pages: number;
}

// One pass over the pages, until the last page comes back short. The caller decides
// whether to believe it; on its own a walk is only a snapshot of a set that can move.
const walkIssuePages = (gh: GitHubReader, fork: string, label: string): IssueWalk => {
  // A window that shifts forward serves the same issue on two pages, so the walk keys
  // by issue number rather than appending whatever each page hands back.
  const issues = new Map<number, WatchIssue>();
  const query = `state=open&labels=${encodeURIComponent(label)}&per_page=${ISSUE_PAGE_SIZE}`;

  for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
    const raw = readJson(gh, ["api", `repos/${fork}/issues?${query}&page=${page}`]);
    if (!Array.isArray(raw)) throw new Error(`gh api repos/${fork}/issues did not return an array`);
    for (const entry of raw) {
      // The issues endpoint also serves pull requests; a watch is never one.
      if (field(entry, "pull_request") !== undefined) continue;
      const number =
        typeof field(entry, "number") === "number" ? (field(entry, "number") as number) : 0;
      issues.set(number, {
        number,
        title: stringField(entry, "title"),
        url: stringField(entry, "html_url"),
        body: stringField(entry, "body"),
      });
    }
    if (raw.length < ISSUE_PAGE_SIZE) {
      return {
        issues: [...issues.values()].sort((left, right) => left.number - right.number),
        pages: page,
      };
    }
  }

  throw new Error(
    `${fork} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE_SIZE} open ${label} issues; ` +
      "the sweep refuses to report a list it had to truncate",
  );
};

const sameIssueNumbers = (
  left: ReadonlyArray<WatchIssue>,
  right: ReadonlyArray<WatchIssue>,
): boolean =>
  left.length === right.length &&
  left.every((issue, index) => issue.number === right[index]?.number);

// The complete open set, and provably complete rather than a prefix an offset shift
// quietly shortened.
export const listWatchIssues = (
  gh: GitHubReader,
  fork: string,
  label = WATCH_LABEL,
): ReadonlyArray<WatchIssue> => {
  // The issue list returns an empty page for a label that does not exist, which reads
  // exactly like "nothing waits on upstream". Prove the label before believing that.
  const labelRead = gh.read(["api", `repos/${fork}/labels/${encodeURIComponent(label)}`]);
  if (labelRead.status !== 0) {
    throw new Error(
      `cannot read the ${label} label on ${fork}, so an empty sweep would prove nothing: ${labelRead.stderr.trim()}`,
    );
  }

  let previous: ReadonlyArray<WatchIssue> | null = null;
  for (let walk = 1; walk <= MAX_ISSUE_WALKS; walk += 1) {
    const current = walkIssuePages(gh, fork, label);
    // A walk that fit in one request read one server-side snapshot, so no page boundary
    // existed for the set to shift across and a second walk would prove nothing.
    if (current.pages === 1) return current.issues;
    if (previous !== null && sameIssueNumbers(previous, current.issues)) return current.issues;
    previous = current.issues;
  }

  throw new Error(
    `the open ${label} set on ${fork} changed under every one of ${MAX_ISSUE_WALKS} walks; ` +
      "the sweep refuses to report a list a shifting page could have dropped an issue from",
  );
};

// Only code-span citations count, and only for the upstream repository. A body may
// cite the same item more than once; the first occurrence wins.
export const parseCitations = (body: string, upstream: string): ReadonlyArray<Citation> => {
  const found = new Map<number, Citation>();
  for (const match of body.matchAll(CITATION_PATTERN)) {
    const slug = match[1] ?? "";
    if (slug.toLowerCase() !== upstream.toLowerCase()) continue;
    const number = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isInteger(number) || number <= 0 || found.has(number)) continue;
    found.set(number, { slug, number });
  }
  return [...found.values()].sort((left, right) => left.number - right.number);
};

// `null` means the answer is unknown locally, not "no": the merge commit or the
// target ref may simply not be fetched yet.
export const containsCommit = (git: GitReader, sha: string, target: string): boolean | null => {
  if (git.runResult(["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return null;
  if (git.runResult(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]).status !== 0) {
    return null;
  }
  const ancestor = git.runResult(["merge-base", "--is-ancestor", sha, target]);
  if (ancestor.status === 0) return true;
  if (ancestor.status === 1) return false;
  return null;
};

const resolveTargetSha = (git: GitReader, target: string): string | null => {
  const result = git.runResult(["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
  const sha = result.stdout.trim();
  return result.status === 0 && sha.length > 0 ? sha : null;
};

const resolveCitation = (
  gh: GitHubReader,
  git: GitReader,
  citation: Citation,
  target: string,
): CitationResult => {
  const ref = `\`${citation.slug}#${citation.number}\``;
  const item = readJson(gh, ["api", `repos/${citation.slug}/issues/${citation.number}`]);
  const state = stringField(item, "state");

  if (field(item, "pull_request") === undefined) {
    const closed = state === "closed";
    // A closed upstream issue carries no merge commit, so it can never resolve on its
    // own, but why it closed decides what the operator is being sent to do. Closed as
    // not planned means no fixing pull request exists or ever will, so asking for one
    // sends them hunting for something that cannot be found; that is what `dropped`
    // already says. Only a completed closure that names no merge is `fix-uncited`.
    const notPlanned = closed && stringField(item, "state_reason") === "not_planned";
    const base = { ref, kind: "issue", state, mergeCommit: null, containedInTarget: null } as const;
    if (notPlanned) {
      return {
        ...base,
        status: "dropped",
        detail:
          "the upstream issue closed as not planned; upstream is not fixing it, so decide the fork's own fix and drop the label",
      };
    }
    return {
      ...base,
      status: closed ? "fix-uncited" : "waiting",
      detail: closed
        ? "the upstream issue closed as completed; find the fixing pull request and cite it here"
        : "the upstream issue is still open; keep waiting or fix it in the fork",
    };
  }

  const pull = readJson(gh, ["api", `repos/${citation.slug}/pulls/${citation.number}`]);
  if (field(pull, "merged") !== true) {
    return {
      ref,
      kind: "pull",
      state,
      mergeCommit: null,
      containedInTarget: null,
      status: state === "closed" ? "dropped" : "waiting",
      detail:
        state === "closed"
          ? "the upstream pull request closed without merging; decide the fork's own fix"
          : "the upstream pull request is still open; keep waiting or trial it in a worktree",
    };
  }

  const mergeCommit = stringField(pull, "merge_commit_sha");
  const contained = mergeCommit.length === 0 ? null : containsCommit(git, mergeCommit, target);
  if (contained === true) {
    return {
      ref,
      kind: "pull",
      state,
      mergeCommit,
      containedInTarget: true,
      status: "ready",
      detail: `merged as ${mergeCommit.slice(0, 12)} and contained in ${target}; it rides this rebase, so verify it in the fork release and close there naming that merge commit`,
    };
  }
  if (contained === false) {
    return {
      ref,
      kind: "pull",
      state,
      mergeCommit,
      containedInTarget: false,
      status: "pending-tag",
      detail: `merged as ${mergeCommit.slice(0, 12)} but not in ${target}; pick a newer tag or keep waiting`,
    };
  }
  return {
    ref,
    kind: "pull",
    state,
    mergeCommit: mergeCommit.length === 0 ? null : mergeCommit,
    containedInTarget: null,
    status: "unresolved",
    detail: `merged, but containment in ${target} is unknown locally; run git fetch upstream --tags`,
  };
};

// The least advanced citation that can still advance. Spent citations only decide the
// roll-up when every citation is spent, so a watch that also cites the merged fix is
// free to reach `ready`.
export const rollUpStatus = (citations: ReadonlyArray<CitationResult>): WatchStatus => {
  if (citations.length === 0) return "uncited";
  const live = citations.filter((citation) => !SPENT_STATUSES.has(citation.status));
  const deciding = live.length > 0 ? live : citations;
  let index = STATUS_ORDER.length - 1;
  for (const citation of deciding) {
    index = Math.min(index, STATUS_ORDER.indexOf(citation.status));
  }
  return STATUS_ORDER[index] ?? "unresolved";
};

export const buildSweep = (
  gh: GitHubReader,
  git: GitReader,
  options: SweepOptions,
): UpstreamWatchSweep => {
  const issues = listWatchIssues(gh, options.fork).map((issue) => {
    const citations = parseCitations(issue.body, options.upstream).map((citation) =>
      resolveCitation(gh, git, citation, options.target),
    );
    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      status: rollUpStatus(citations),
      citations,
    };
  });

  return {
    fork: options.fork,
    upstream: options.upstream,
    label: WATCH_LABEL,
    target: options.target,
    targetSha: resolveTargetSha(git, options.target),
    issues,
  };
};

const countByStatus = (sweep: UpstreamWatchSweep): ReadonlyArray<string> =>
  STATUS_ORDER.map((status) => ({
    status,
    count: sweep.issues.filter((issue) => issue.status === status).length,
  }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.status}`);

export const renderSweep = (sweep: UpstreamWatchSweep): string => {
  const lines: Array<string> = [
    `${sweep.label} sweep`,
    `  fork:     ${sweep.fork}`,
    `  upstream: ${sweep.upstream}`,
    `  target:   ${sweep.target}${sweep.targetSha === null ? " (not available locally)" : ` (${sweep.targetSha.slice(0, 12)})`}`,
    "",
  ];

  if (sweep.issues.length === 0) {
    lines.push(`No open ${sweep.label} issues. Nothing waits on upstream.`, "");
    return lines.join("\n");
  }

  for (const issue of sweep.issues) {
    lines.push(`#${issue.number} [${issue.status}] ${issue.title}`);
    if (issue.citations.length === 0) {
      lines.push("  no upstream citation in the body; add one as a code span or drop the label");
    }
    for (const citation of issue.citations) {
      lines.push(`  ${citation.ref} ${citation.kind} ${citation.state}`);
      lines.push(`    ${citation.detail}`);
    }
    lines.push(`  ${issue.url}`);
    lines.push("");
  }

  lines.push(`${sweep.issues.length} open: ${countByStatus(sweep).join(", ")}`, "");
  return lines.join("\n");
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    const options = parseArgs(argv);
    const git = new SystemGit(cwd);
    const root = git.runResult(["rev-parse", "--show-toplevel"]).stdout.trim();
    const sweep = buildSweep(
      new SystemGitHub(root.length > 0 ? root : cwd),
      new SystemGit(root.length > 0 ? root : cwd),
      options,
    );
    process.stdout.write(options.json ? `${JSON.stringify(sweep, null, 2)}\n` : renderSweep(sweep));
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
