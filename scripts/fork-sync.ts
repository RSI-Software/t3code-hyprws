#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The sync driver bootstraps Git before any Effect runtime exists.
//
// One driver, one run, one exit code, one report. `fork:sync [<tag>] [--dry-run]`
// walks one upstream release tag end to end: target, fetch, rebase, check, push,
// blocked, report. There is no state machine, no gates, no lanes, and no modes —
// a rerun of the same command is always the next move.
//
// | Step    | Fails when                                         |
// | ------- | -------------------------------------------------- |
// | target  | the named target is not a release tag on upstream  |
// | fetch   | the fetch errors                                   |
// | rebase  | a conflict neither rerere nor hook re-apply fixes  |
// | check   | `fork:delta --check`, `fork:scan`, or types is red |
// | push    | the expected-old lease is refused                  |
// | blocked | `ghb` is unavailable                               |
//
// The typed report at `.t3/fork-sync/<tag>.json` is the only run authority; the
// Markdown this prints is output, never read back. Publication goes through
// `ghb`, never bare `gh`, and nothing is ever posted to upstream.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { publishRerereSnapshot, restoreRerereCache, saveRerereCache } from "./lib/fork-bot-refs.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import {
  commandText,
  requireCommandSuccess,
  runCommand,
  type CommandResult,
} from "./lib/fork-command.ts";
import { deriveForkHooksIn } from "./lib/fork-hooks.ts";
import { reapplyForkHooks } from "./lib/fork-hook-reapply.ts";
import {
  FORK_REPOSITORY,
  HYPRWS_BRANCH,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./lib/fork-policy.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYNC_DIR = ".t3/fork-sync";
const WORKTREE_DIR = "worktree";
/** ghb issues only this label from the governed set; the title search does the rest. */
const BLOCK_LABEL = "ci";
const BLOCK_TITLE_PHRASE = '"hyprws sync blocked" in:title';
const REPORT_SCHEMA = "fork.sync-report.v1";
/** The task the sync program files under; taxonomy Source is `repo#number` form. */
const BLOCK_SOURCE_ISSUE = "1151";

const blockIssueTitle = (tag: string, blockingShortSha: string): string =>
  `hyprws sync blocked at ${tag} (upstream ${blockingShortSha})`;

const blockingShaMarker = (sha: string): string => `<!-- blocking-sha:${sha} -->`;
export { blockingShaMarker };

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface CommandSpec {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stream?: boolean;
}

export interface CommandRunner {
  run(command: string, args: ReadonlyArray<string>, spec: CommandSpec): CommandResult;
}

/** The production runner: every command is a real child process. */
export const realRunner: CommandRunner = {
  run: (command, args, spec) =>
    runCommand(command, args, {
      cwd: spec.cwd,
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(spec.stream === undefined ? {} : { stream: spec.stream }),
    }),
};

const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const gitResult = (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
): CommandResult => runner.run("git", args, { cwd });

const git = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): string => {
  const result = gitResult(runner, cwd, args);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.error?.message || "no output"}`,
    );
  return result.stdout.trim();
};

/** A git command whose failure the run itself tolerates. */
const gitAllow = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): void => {
  gitResult(runner, cwd, args);
};

const runRequire = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  spec: CommandSpec,
): string => requireCommandSuccess(runner.run(command, args, spec), command, args);

// ---------------------------------------------------------------------------
// Typed report
// ---------------------------------------------------------------------------

/** How a conflict row resolved. Rerere's autoupdated replays never leave an unmerged path. */
export const ConflictVia = Schema.Literals(["rerere", "hook", "human"]);

export const ConflictRow = Schema.Struct({
  /** Repo-relative path of the conflicted file. */
  path: Schema.String,
  /** The fork commit being replayed when the path conflicted. */
  forkCommit: Schema.String,
  forkSubject: Schema.String,
  /** The newest upstream commit that touched the path on the target side. */
  upstreamCommit: Schema.String,
  upstreamSubject: Schema.String,
  /** The resolution the run applied, or `human` when the run stopped. */
  via: ConflictVia,
  /** Hook keys re-inserted by hook re-apply; empty for every other row. */
  hooksReapplied: Schema.Array(Schema.String),
});
export interface ConflictRow extends Schema.Schema.Type<typeof ConflictRow> {}

/**
 * The typed decision route a stopped run leaves behind. Recovery reads this —
 * resolve the named paths in the named worktree, continue the rebase, rerun.
 */
export const DecisionRoute = Schema.Struct({
  /** The detached worktree holding the stopped rebase; `""` when nothing to resume. */
  worktree: Schema.String,
  /** The paths a human resolves there. */
  paths: Schema.Array(Schema.String),
  /** The exact resume commands, verbatim. */
  resume: Schema.String,
});
export interface DecisionRoute extends Schema.Schema.Type<typeof DecisionRoute> {}

export const CheckRow = Schema.Struct({
  command: Schema.String,
  status: Schema.Literals(["passed", "failed", "skipped"]),
  detail: Schema.String,
});
export interface CheckRow extends Schema.Schema.Type<typeof CheckRow> {}

export const ForkSyncReport = Schema.Struct({
  schema: Schema.Literal(REPORT_SCHEMA),
  outcome: Schema.Literals(["applied", "already-applied", "blocked", "failed"]),
  dryRun: Schema.Boolean,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  repository: Schema.String,
  target: Schema.Struct({ tag: Schema.String, sha: Schema.String }),
  /** The documented expected-old lease: the `origin/hyprws` sha the run fetched. */
  lease: Schema.Struct({ expectedOld: Schema.String }),
  trunk: Schema.Struct({
    before: Schema.String,
    /** The rebased tip; `null` when no rebase completed. */
    after: Schema.NullOr(Schema.String),
  }),
  /** The scan base: `git merge-base upstream/main <tip>`. */
  base: Schema.String,
  rerere: Schema.Struct({
    restored: Schema.Boolean,
    saved: Schema.Boolean,
    published: Schema.Boolean,
  }),
  conflicts: Schema.Array(ConflictRow),
  checks: Schema.Array(CheckRow),
  decision: DecisionRoute,
  blocked: Schema.NullOr(
    Schema.Struct({
      /** The open issue carrying the block; `null` when unfiled or dry-run. */
      issue: Schema.NullOr(Schema.Number),
      title: Schema.String,
      blockingSha: Schema.String,
      publishError: Schema.NullOr(Schema.String),
      /** Which CLI posted: `ghb` when present, `gh` when it cannot spawn. */
      publishedVia: Schema.NullOr(Schema.Literals(["ghb", "gh"])),
    }),
  ),
  push: Schema.Struct({ pushed: Schema.Boolean, detail: Schema.String }),
  error: Schema.NullOr(Schema.String),
});
export interface ForkSyncReport extends Schema.Schema.Type<typeof ForkSyncReport> {}

const emptyDecision = (): DecisionRoute => ({ worktree: "", paths: [], resume: "" });

export const reportPath = (root: string, tag: string): string =>
  NodePath.join(root, SYNC_DIR, `${tag}.json`);

/** Prove the report against its schema, then persist it. Decisions hit disk before any post. */
const writeReport = (root: string, report: ForkSyncReport): string => {
  Schema.decodeUnknownSync(ForkSyncReport)(report);
  const path = reportPath(root, report.target.tag);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};

/** Post-push recovery reads the typed report, never a rendered comment. */
export const readReport = (root: string, tag: string): ForkSyncReport =>
  Schema.decodeSync(ForkSyncReport)(JSON.parse(NodeFS.readFileSync(reportPath(root, tag), "utf8")));

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * The release tags upstream published onto `upstream/main`'s first-parent lane,
 * oldest first (`--reverse`), since `positionUpstreamReleaseTags` and
 * `selectNewestReleaseTag` treat a higher first-parent position as newer.
 */
export const releaseTags = (runner: CommandRunner, root: string): ReleaseTag[] => {
  const firstParentShas = lines(
    git(runner, root, ["rev-list", "--first-parent", "--reverse", "upstream/main"]),
  );
  const positioned = positionUpstreamReleaseTags(
    { run: (args) => git(runner, root, args) },
    firstParentShas,
  );
  return positioned
    .toSorted((left, right) => (selectNewestReleaseTag([left, right]) === left ? -1 : 1))
    .map(({ tag, sha }) => ({ tag, sha }));
};

export interface ReleaseTag {
  readonly tag: string;
  readonly sha: string;
}

export const resolveTarget = (
  candidates: ReadonlyArray<ReleaseTag>,
  explicit: string | null,
): ReleaseTag => {
  if (explicit !== null) {
    const named = candidates.find(({ tag }) => tag === explicit);
    if (named === undefined)
      throw new Error(`${explicit} is not a release tag on upstream; pass a v… tag or none`);
    return named;
  }
  const newest = candidates[0];
  if (newest === undefined) throw new Error("upstream publishes no release tags");
  return newest;
};

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

const REBASE_CONFIG = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "diff.algorithm=histogram",
  "-c",
  "rerere.enabled=true",
];

export const worktreePath = (root: string): string => NodePath.join(root, SYNC_DIR, WORKTREE_DIR);

const stageContent = (
  runner: CommandRunner,
  worktree: string,
  stage: 1 | 2 | 3,
  path: string,
): string | null => {
  const result = gitResult(runner, worktree, ["show", `:${stage}:${path}`]);
  return result.status === 0 && result.error === undefined ? result.stdout : null;
};

const upstreamTouch = (
  runner: CommandRunner,
  root: string,
  tagSha: string,
  path: string,
): { sha: string; subject: string } => {
  const raw = git(runner, root, ["log", "-1", "--format=%H%x1f%s", tagSha, "--", path]);
  const [sha = "", subject = ""] = raw.split("\x1f");
  return { sha: sha || tagSha, subject: subject || "" };
};

/**
 * Hook re-apply for one conflicted path: the merged text is the upstream side
 * (`:2:`), the fork side (`:3:`) declares the hooks, and every reinserted key is
 * named. `null` when the path is not purely a hook re-insertion.
 */
const reapplyHooks = (
  runner: CommandRunner,
  worktree: string,
  path: string,
): ReadonlyArray<string> | null => {
  const ours = stageContent(runner, worktree, 2, path);
  const theirs = stageContent(runner, worktree, 3, path);
  if (ours === null || theirs === null) return null;
  let entries;
  try {
    entries = deriveForkHooksIn(path, theirs);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const result = reapplyForkHooks(
    ours,
    theirs,
    entries.map(({ key, anchor, span }) => ({ key, anchor, span })),
  );
  if (result.results.some(({ outcome }) => outcome.status === "refuse")) return null;
  if (result.reinserted.length === 0) return null;
  NodeFS.writeFileSync(NodePath.join(worktree, path), result.text);
  git(runner, worktree, ["add", "--", path]);
  return result.reinserted;
};

export type RebaseOutcome =
  | {
      readonly status: "applied";
      readonly newSha: string;
      readonly conflicts: ReadonlyArray<ConflictRow>;
    }
  | { readonly status: "blocked"; readonly conflicts: ReadonlyArray<ConflictRow> };

/**
 * Rebase `oldSha` onto `target` in a detached worktree. Known seams resolve by
 * themselves: rerere autoupdate stages them, and hook re-apply re-inserts the
 * marked fork hooks a conflicted file declares. Any path left standing after
 * both stops the run; its rows name the fork commit, the upstream commit, and
 * the worktree a human resumes in.
 */
export const rebaseOnto = (
  runner: CommandRunner,
  root: string,
  target: ReleaseTag,
  oldSha: string,
): RebaseOutcome => {
  const worktree = worktreePath(root);
  gitAllow(runner, root, ["worktree", "remove", "--force", worktree]);
  git(runner, root, ["worktree", "prune"]);
  git(runner, root, ["worktree", "add", "--quiet", "--detach", worktree, oldSha]);
  const editorEnv = { ...process.env, GIT_EDITOR: "true" };
  const rebaseArgs = ["rebase", "--rerere-autoupdate", target.sha];
  const conflicts: ConflictRow[] = [];
  const forkCommitCount = Number(
    git(runner, root, ["rev-list", "--count", `${target.sha}..${oldSha}`]),
  );
  let status = gitResult(runner, worktree, [...REBASE_CONFIG, ...rebaseArgs]);
  let stops = 0;
  while (status.status !== 0) {
    stops += 1;
    if (stops > forkCommitCount + 10)
      throw new Error(`the rebase stopped more times than it had commits to replay (${stops})`);
    if (gitResult(runner, worktree, ["rev-parse", "--verify", "REBASE_HEAD"]).status !== 0)
      throw new Error(
        `git rebase failed without a stop: ${status.stderr.trim() || status.stdout.trim() || "no output"}`,
      );
    const forkCommit = git(runner, worktree, ["rev-parse", "REBASE_HEAD"]);
    const forkSubject = git(runner, worktree, ["log", "-1", "--format=%s", "REBASE_HEAD"]);
    const unmerged = lines(git(runner, worktree, ["diff", "--name-only", "--diff-filter=U"]));
    const human: string[] = [];
    for (const path of unmerged) {
      const touch = upstreamTouch(runner, root, target.sha, path);
      const applied = reapplyHooks(runner, worktree, path);
      if (applied === null) {
        human.push(path);
        conflicts.push({
          path,
          forkCommit,
          forkSubject,
          upstreamCommit: touch.sha,
          upstreamSubject: touch.subject,
          via: "human",
          hooksReapplied: [],
        });
        continue;
      }
      conflicts.push({
        path,
        forkCommit,
        forkSubject,
        upstreamCommit: touch.sha,
        upstreamSubject: touch.subject,
        via: "hook",
        hooksReapplied: [...applied],
      });
    }
    if (human.length > 0) return { status: "blocked", conflicts };
    status = runner.run("git", [...REBASE_CONFIG, "rebase", "--continue"], {
      cwd: worktree,
      env: editorEnv,
    });
  }
  return {
    status: "applied",
    newSha: git(runner, worktree, ["rev-parse", "HEAD"]),
    conflicts,
  };
};

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

const VERIFICATION_ENV_KEYS = [
  // Vite+'s `node_modules/.bin/vp` shim exports an absolute NODE_PATH into the
  // store of the checkout it belongs to; inherited, it pins module resolution
  // for every process below to a foreign store.
  "NODE_PATH",
  "NPM_CONFIG_REGISTRY",
  "VP_ENV_USE_EVAL_ENABLE",
  "VP_NODE_DIST_MIRROR",
  "VP_NODE_SKIP_SIGNATURE_VERIFY",
  "VP_NODE_VERSION",
  // The push credential lives in the Git environment. Check commands run
  // rebased code, which must never see it; the driver's own pushes keep it.
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "HYPRWS_PUSH_TOKEN",
];

/** The worktree's own `.bin` first, and no other checkout's bin directory at all. */
const worktreeExecutablePath = (inherited: string | undefined, worktree: string): string => {
  const worktreeBin = NodePath.join(worktree, "node_modules", ".bin");
  const entries = (inherited ?? "")
    .split(NodePath.delimiter)
    .filter(
      (entry) =>
        entry.length > 0 &&
        entry !== worktreeBin &&
        !NodePath.resolve(entry).split(NodePath.sep).includes("node_modules"),
    );
  return [worktreeBin, ...entries].join(NodePath.delimiter);
};

const verificationEnv = (worktree: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !VERIFICATION_ENV_KEYS.includes(key)),
  ),
  PATH: worktreeExecutablePath(process.env.PATH, worktree),
});

/**
 * Reuse one checkout's pnpm install from the detached worktree: workspace links
 * are copied verbatim so they resolve to the rebased sources, the root store is
 * shared directly.
 */
export const linkInstalledModules = (root: string, worktree: string): void => {
  const copyModuleLinks = (source: string, destination: string): void => {
    NodeFS.mkdirSync(destination, { recursive: true });
    for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = NodePath.join(source, entry.name);
      const destinationPath = NodePath.join(destination, entry.name);
      if (entry.isSymbolicLink()) {
        NodeFS.symlinkSync(NodeFS.readlinkSync(sourcePath), destinationPath);
      } else if (entry.isDirectory()) {
        copyModuleLinks(sourcePath, destinationPath);
      } else {
        NodeFS.copyFileSync(sourcePath, destinationPath);
      }
    }
  };
  const visit = (directory: string, depth: number): void => {
    const relative = NodePath.relative(root, directory);
    const sourceModules = NodePath.join(directory, "node_modules");
    const worktreeModules = NodePath.join(worktree, relative, "node_modules");
    if (NodeFS.existsSync(sourceModules) && !NodeFS.existsSync(worktreeModules)) {
      if (relative.length === 0) NodeFS.symlinkSync(sourceModules, worktreeModules, "dir");
      else copyModuleLinks(sourceModules, worktreeModules);
    }
    if (depth === 2) return;
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".repos" ||
        entry.name === ".t3"
      )
        continue;
      visit(NodePath.join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
};

/** The check battery, in the CI shape. */
export const checkCommands = (
  base: string,
  since: string,
): ReadonlyArray<ReadonlyArray<string>> => [
  ["run", "fork:delta", "--check"],
  [
    "run",
    "fork:scan",
    "--head",
    "HEAD",
    "--target",
    base,
    "--since",
    since,
    "--no-typecheck",
    "--replay-of",
    `origin/${HYPRWS_BRANCH}`,
  ],
  ["run", "--filter", "@t3tools/scripts", "typecheck"],
];

export const runChecks = (
  runner: CommandRunner,
  root: string,
  worktree: string,
  base: string,
  since: string,
): ReadonlyArray<CheckRow> => {
  linkInstalledModules(root, worktree);
  const env = verificationEnv(worktree);
  return checkCommands(base, since).map((args) => {
    const result = runner.run("vp", args, { cwd: worktree, env, stream: true });
    return result.status === 0 && result.error === undefined
      ? { command: commandText("vp", args), status: "passed", detail: "" }
      : {
          command: commandText("vp", args),
          status: "failed",
          detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`,
        };
  });
};

// ---------------------------------------------------------------------------
// Blocked publication
// ---------------------------------------------------------------------------

export const blockingShaOf = (conflicts: ReadonlyArray<ConflictRow>): string | null =>
  conflicts.find((row) => row.via === "human")?.upstreamCommit ??
  conflicts[0]?.upstreamCommit ??
  null;

export const blockedIssueBody = (report: ForkSyncReport): string => {
  const cell = (value: string): string =>
    `\`${value.replaceAll("\\", "\\\\").replaceAll("|", "\\|")}\``;
  const blocked = report.blocked!;
  const first = report.conflicts[0];
  return [
    `Origin: hyprws sync run onto ${report.target.tag}; \`vp run fork:sync ${report.target.tag}\`.`,
    "",
    `A sync run rebased \`${HYPRWS_BRANCH}\` onto \`${report.target.tag}\` and stopped at a seam neither rerere nor hook re-apply resolves.`,
    "",
    `Blocking upstream commit: ${cell(`${blocked.blockingSha} ${first?.upstreamSubject ?? ""}`)}`,
    "",
    "| Path | Fork commit | Upstream commit |",
    "| --- | --- | --- |",
    ...report.conflicts.map(
      (row) =>
        `| ${cell(row.path)} | ${cell(`${row.forkCommit.slice(0, 7)} ${row.forkSubject}`)} | ${cell(`${row.upstreamCommit.slice(0, 7)} ${row.upstreamSubject}`)} |`,
    ),
    "",
    "## Resume",
    "",
    "The typed report is the authority; this issue is a projection of it.",
    "",
    "```bash",
    report.decision.resume,
    "```",
    "",
    "A rerun on the same upstream commit updates this issue; a clean run closes it.",
    `Report: \`${SYNC_DIR}/${report.target.tag}.json\` (schema \`${REPORT_SCHEMA}\`).`,
    "",
    blockingShaMarker(blocked.blockingSha),
  ].join("\n");
};

export interface OpenBlockIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface GitHub {
  /** Which CLI posts the writes: `ghb` when present, `gh` when `ghb` cannot spawn. */
  readonly route: "ghb" | "gh";
  readonly list: () => ReadonlyArray<OpenBlockIssue>;
  readonly create: (title: string, bodyPath: string) => number | null;
  readonly comment: (issue: number, bodyPath: string) => void;
  readonly close: (issue: number, comment: string) => void;
}

/** The governed filing ghb performs; `gh` cannot set these fields. */
const ghbCreateArgs = (repo: ReadonlyArray<string>, title: string, bodyPath: string) => [
  "issue",
  "create",
  ...repo,
  "--title",
  title,
  "--body-file",
  bodyPath,
  "--type",
  "Notification 🔔",
  "--priority",
  "High",
  "--filed-by",
  "Agent 🤖",
  "--source",
  BLOCK_SOURCE_ISSUE,
  "--label",
  BLOCK_LABEL,
  "--no-project",
  "--no-relationship",
];

/**
 * `ghb` first: its filing is governed and attested. CI has no `ghb`, so when the
 * binary cannot spawn at all the writes fall back to bare `gh` with the same
 * body, title, and marker. A `ghb` that runs but refuses never falls back — the
 * refusal is the observation, and `gh` must not route around governance.
 */
export const githubClient = (runner: CommandRunner, root: string): GitHub => {
  const repo = ["--repo", FORK_REPOSITORY];
  const probe = runner.run("ghb", ["--version"], { cwd: root });
  const route = probe.error === undefined ? "ghb" : "gh";
  const list = () =>
    JSON.parse(
      runRequire(
        runner,
        "gh",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          BLOCK_LABEL,
          "--search",
          BLOCK_TITLE_PHRASE,
          ...repo,
          "--json",
          "number,title,body",
        ],
        { cwd: root },
      ),
    ) as ReadonlyArray<OpenBlockIssue>;
  if (route === "gh")
    return {
      route,
      list,
      create: (title, bodyPath) => {
        const result = runner.run(
          "gh",
          [
            "issue",
            "create",
            ...repo,
            "--title",
            title,
            "--body-file",
            bodyPath,
            "--label",
            BLOCK_LABEL,
          ],
          { cwd: root },
        );
        if (result.status !== 0 || result.error !== undefined)
          throw new Error(
            `gh issue create failed: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "no output"}`,
          );
        const url = /issues\/(\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
        return url === undefined ? null : Number(url);
      },
      comment: (issue, bodyPath) => {
        runRequire(
          runner,
          "gh",
          ["issue", "comment", String(issue), ...repo, "--body-file", bodyPath],
          { cwd: root },
        );
      },
      close: (issue, comment) => {
        runRequire(
          runner,
          "gh",
          ["issue", "close", String(issue), "--reason", "completed", "--comment", comment, ...repo],
          { cwd: root },
        );
      },
    };
  return {
    route,
    list,
    create: (title, bodyPath) => {
      const result = runner.run("ghb", ghbCreateArgs(repo, title, bodyPath), { cwd: root });
      if (result.status !== 0 || result.error !== undefined)
        throw new Error(
          `ghb issue create refused: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "no output"}`,
        );
      const url = /issues\/(\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
      return url === undefined ? null : Number(url);
    },
    comment: (issue, bodyPath) => {
      runRequire(
        runner,
        "ghb",
        ["issue", "comment", String(issue), ...repo, "--body-file", bodyPath],
        { cwd: root },
      );
    },
    close: (issue, comment) => {
      runRequire(
        runner,
        "ghb",
        ["issue", "close", String(issue), "--reason", "completed", "--comment", comment, ...repo],
        { cwd: root },
      );
    },
  };
};

const withBodyFile = <T>(body: string, effect: (path: string) => T): T => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-body-"));
  const path = NodePath.join(directory, "body.md");
  NodeFS.writeFileSync(path, body);
  try {
    return effect(path);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * Upsert the one open block issue keyed by the blocking sha. A `ghb` that
 * refuses is the raw observation printed with the body, and the run exits
 * non-zero with `blocked.publishError` set on the report.
 */
export const publishBlock = (
  runner: CommandRunner,
  root: string,
  report: ForkSyncReport,
): ForkSyncReport => {
  const blocked = report.blocked!;
  const body = blockedIssueBody(report);
  try {
    const github = githubClient(runner, root);
    const existing = github
      .list()
      .find((issue) => issue.body.includes(blockingShaMarker(blocked.blockingSha)));
    return withBodyFile(body, (bodyPath) => {
      if (existing !== undefined) {
        github.comment(existing.number, bodyPath);
        return {
          ...report,
          blocked: {
            ...blocked,
            issue: existing.number,
            publishError: null,
            publishedVia: github.route,
          },
        };
      }
      const number = github.create(blocked.title, bodyPath);
      return {
        ...report,
        blocked: {
          ...blocked,
          ...(number === null ? {} : { issue: number }),
          publishError: null,
          publishedVia: github.route,
        },
      };
    });
  } catch (error) {
    process.stdout.write(`${body}\n`);
    return {
      ...report,
      blocked: {
        ...blocked,
        publishError: error instanceof Error ? error.message : String(error),
        publishedVia: null,
      },
    };
  }
};

/** A clean run closes every open block issue: the trunk moved, so none can block. */
export const closeBlocks = (
  runner: CommandRunner,
  root: string,
  newSha: string,
): ReadonlyArray<number> => {
  const github = githubClient(runner, root);
  const closed: number[] = [];
  for (const issue of github.list()) {
    github.close(issue.number, `Resolved by ${HYPRWS_BRANCH} ${newSha}.`);
    closed.push(issue.number);
  }
  return closed;
};

// ---------------------------------------------------------------------------
// Rendering — output only, never read back
// ---------------------------------------------------------------------------

export const renderReport = (report: ForkSyncReport): string => {
  const head = {
    applied: "✅ applied",
    "already-applied": "✅ already applied",
    blocked: "🛑 blocked",
    failed: "❌ failed",
  }[report.outcome];
  const rows = [
    `Run: ${head}${report.dryRun ? " (dry run)" : ""} — ${report.target.tag}@${report.target.sha.slice(0, 7)}`,
    `Trunk: ${report.trunk.before.slice(0, 7)} → ${report.trunk.after === null ? "unchanged" : report.trunk.after.slice(0, 7)}`,
    `Lease: origin/${HYPRWS_BRANCH} at ${report.lease.expectedOld.slice(0, 7)}`,
    `Rerere: ${report.rerere.restored ? "restored" : "cold"}, ${report.rerere.saved ? "saved" : "nothing saved"}${report.rerere.published ? ", published" : ""}`,
    `Report: ${SYNC_DIR}/${report.target.tag}.json`,
  ];
  const conflictTable =
    report.conflicts.length === 0
      ? []
      : [
          "",
          "| Path | Fork commit | Upstream commit | Via |",
          "| --- | --- | --- | --- |",
          ...report.conflicts.map(
            (row) =>
              `| \`${row.path}\` | \`${row.forkCommit.slice(0, 7)} ${row.forkSubject}\` | \`${row.upstreamCommit.slice(0, 7)} ${row.upstreamSubject}\` | ${row.via}${row.hooksReapplied.length > 0 ? ` (${row.hooksReapplied.join(", ")})` : ""} |`,
          ),
        ];
  const checks =
    report.checks.length === 0
      ? []
      : [
          "",
          ...report.checks.map(
            (check) => `- ${check.status === "passed" ? "✅" : "❌"} \`${check.command}\``,
          ),
        ];
  const decision =
    report.decision.worktree === ""
      ? []
      : [
          "",
          "## Decision route",
          "",
          `Worktree: \`${report.decision.worktree}\``,
          `Paths: ${report.decision.paths.map((path) => `\`${path}\``).join(", ")}`,
          "",
          "```bash",
          report.decision.resume,
          "```",
        ];
  const failure = report.error === null ? [] : ["", `Error: ${report.error}`];
  return [...rows, ...conflictTable, ...checks, ...decision, ...failure].join("\n");
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly runner?: CommandRunner;
  readonly root?: string;
  readonly now?: () => Date;
}

const USAGE = "usage: vp run fork:sync [<tag>] [--dry-run]";

export const run = (argv: ReadonlyArray<string>, options: RunOptions = {}): number => {
  const runner = options.runner ?? realRunner;
  const root = options.root ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let parsed;
  try {
    parsed = parseArgs(argv, { positionals: { min: 0, max: 1 }, flags: ["--dry-run"] });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  const dryRun = parsed.flags.has("--dry-run");
  const explicit = parsed.positionals[0] ?? null;

  const finish = (report: ForkSyncReport): number => {
    const path = writeReport(root, report);
    process.stdout.write(`${renderReport(report)}\n${path}\n`);
    return report.outcome === "applied" || report.outcome === "already-applied" ? 0 : 1;
  };

  try {
    // fetch — the tag list and the trunk lease both come from the remotes
    git(runner, root, ["fetch", "--tags", "upstream"]);
    git(runner, root, ["fetch", "origin", HYPRWS_BRANCH]);
    const expectedOld = git(runner, root, ["rev-parse", `origin/${HYPRWS_BRANCH}`]);
    const mergeBase = (tip: string): string =>
      git(runner, root, ["merge-base", "upstream/main", tip]);

    const frame = (partial: Partial<ForkSyncReport>): ForkSyncReport => ({
      schema: REPORT_SCHEMA,
      outcome: "failed",
      dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      repository: FORK_REPOSITORY,
      target: { tag: target.tag, sha: target.sha },
      lease: { expectedOld },
      trunk: { before: expectedOld, after: null },
      base: mergeBase(expectedOld),
      rerere: { restored: false, saved: false, published: false },
      conflicts: [],
      checks: [],
      decision: emptyDecision(),
      blocked: null,
      push: { pushed: false, detail: "" },
      error: null,
      ...partial,
    });

    // target — a tag the fork already sits on exits 0 with `already applied`
    const target = resolveTarget(releaseTags(runner, root), explicit);

    if (
      gitResult(runner, root, ["merge-base", "--is-ancestor", target.sha, expectedOld]).status === 0
    )
      return finish(
        frame({
          outcome: "already-applied",
          trunk: { before: expectedOld, after: expectedOld },
        }),
      );

    // rebase
    const restored = restoreRerereCache(root);
    const rerere = { restored, saved: false, published: false };
    const rebase = rebaseOnto(runner, root, target, expectedOld);

    const teachRerere = (): void => {
      // Every run teaches rerere something, applied or stopped; publication is a
      // push, so a dry run keeps the snapshot local. A refused publication never
      // fails the run — the snapshot is retained for the next one.
      const snapshot = saveRerereCache(root, `rerere: ${HYPRWS_BRANCH} onto ${target.tag}`);
      if (snapshot === null) return;
      rerere.saved = true;
      if (dryRun) return;
      try {
        publishRerereSnapshot(root, snapshot);
        rerere.published = true;
      } catch (error) {
        process.stderr.write(
          `note: rerere publication failed; the snapshot is retained locally: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    };

    if (rebase.status === "blocked") {
      teachRerere();
      const humanPaths = rebase.conflicts
        .filter((row) => row.via === "human")
        .map((row) => row.path);
      const blockingSha = blockingShaOf(rebase.conflicts) ?? target.sha;
      const worktree = worktreePath(root);
      // decisions persist before any comment posts
      const blockedReport = frame({
        outcome: "blocked",
        rerere: { ...rerere },
        conflicts: [...rebase.conflicts],
        decision: {
          worktree,
          paths: humanPaths,
          resume: [
            `git -C ${worktree} add -- ${humanPaths.map((path) => `"${path}"`).join(" ")}`,
            `git -C ${worktree} rebase --continue`,
            `vp run fork:sync ${target.tag}${dryRun ? " --dry-run" : ""}`,
          ].join("\n"),
        },
        blocked: {
          issue: null,
          title: blockIssueTitle(target.tag, blockingSha.slice(0, 7)),
          blockingSha,
          publishError: null,
          publishedVia: null,
        },
        error: `blocked by ${blockingSha.slice(0, 7)}: ${humanPaths.length} path${humanPaths.length === 1 ? "" : "s"} neither rerere nor hook re-apply resolves`,
      });
      writeReport(root, blockedReport);
      process.stdout.write(`${renderReport(blockedReport)}\n`);
      if (dryRun) {
        process.stdout.write(`${blockedIssueBody(blockedReport)}\n`);
        return 1;
      }
      const published = publishBlock(runner, root, blockedReport);
      const path = writeReport(root, published);
      process.stdout.write(
        published.blocked?.publishError !== null && published.blocked?.publishError !== undefined
          ? `block publication failed: ${published.blocked.publishError}\n${path}\n`
          : `${path}\n`,
      );
      return 1;
    }
    const newSha = rebase.newSha;

    // check
    const checks = runChecks(runner, root, worktreePath(root), mergeBase(newSha), expectedOld);
    if (checks.some((check) => check.status === "failed")) {
      teachRerere();
      gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
      return finish(
        frame({
          rerere: { ...rerere },
          conflicts: [...rebase.conflicts],
          checks,
          error: "the check battery is red",
        }),
      );
    }

    // push — the documented expected-old lease; a dry run reaches applied without it
    if (dryRun) {
      teachRerere();
      gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
      return finish(
        frame({
          outcome: "applied",
          trunk: { before: expectedOld, after: newSha },
          rerere: { ...rerere },
          conflicts: [...rebase.conflicts],
          checks,
          push: { pushed: false, detail: "dry run" },
        }),
      );
    }
    const pushed = gitResult(runner, root, [
      "push",
      "origin",
      `${newSha}:${HYPRWS_BRANCH}`,
      `--force-with-lease=${HYPRWS_BRANCH}:${expectedOld}`,
    ]);
    const pushRefused = pushed.status !== 0 || pushed.error !== undefined;
    teachRerere();
    gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
    if (pushRefused)
      return finish(
        frame({
          rerere: { ...rerere },
          conflicts: [...rebase.conflicts],
          checks,
          error: `push refused: ${pushed.stderr.trim() || pushed.error?.message || "unknown"}`,
        }),
      );

    const report = finish(
      frame({
        outcome: "applied",
        trunk: { before: expectedOld, after: newSha },
        rerere: { ...rerere },
        conflicts: [...rebase.conflicts],
        checks,
        push: { pushed: true, detail: `${newSha.slice(0, 7)} → origin/${HYPRWS_BRANCH}` },
      }),
    );

    // a clean run closes the block issues it made stale
    try {
      for (const number of closeBlocks(runner, root, newSha))
        process.stdout.write(`closed #${number}\n`);
    } catch (error) {
      process.stderr.write(
        `note: closing stale block issues failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return report;
  } catch (error) {
    const message =
      error instanceof UsageError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    // A tag name known so far keys the failure report; an unresolved target has none.
    if (explicit === null) return 1;
    try {
      return finish({
        schema: REPORT_SCHEMA,
        outcome: "failed",
        dryRun,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        repository: FORK_REPOSITORY,
        target: { tag: explicit, sha: "" },
        lease: { expectedOld: "" },
        trunk: { before: "", after: null },
        base: "",
        rerere: { restored: false, saved: false, published: false },
        conflicts: [],
        checks: [],
        decision: emptyDecision(),
        blocked: null,
        push: { pushed: false, detail: "" },
        error: message,
      });
    } catch {
      return 1;
    }
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
