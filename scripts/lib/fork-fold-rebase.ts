// @effect-diagnostics nodeBuiltinImport:off - Standalone fold tool runs before an Effect runtime exists.
// Gate: local — fork-fold apply's fallback runs it by hand; no workflow invokes it.

// The worktree fallback behind fork-fold apply. The merge-tree fast path stops
// at the first refused block; from that block on the remaining plan replays as
// one `git rebase -i --autosquash` in a throwaway worktree under the git common
// dir, not `.t3/`, which is dev-server state. Each stop keeps the sequencer in
// place; rerunning apply adopts the worktree and continues, so the sequencer
// finishes every group exactly once and `git worktree remove` claims the
// worktree only on a finished fold.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { commandText, type CommandResult } from "./fork-command.ts";
import type { ParsedForkCommit } from "./fork-trailers.ts";

/**
 * The fold's shared data shapes and git interface, home here so every fold
 * module imports them from inside `scripts/lib`: `apps/desktop` typechecks
 * this whole directory, and a fold module outside it would drag its own
 * imports into the desktop project (TS6307).
 */
export interface FoldCommit extends ParsedForkCommit {
  readonly files: ReadonlyArray<string>;
  /** Full commit message (`%B`), so fold messages can carry each member's PR links. */
  readonly message: string;
}

export interface FoldStack {
  readonly base: string;
  readonly head: string;
  readonly commits: ReadonlyArray<FoldCommit>;
}

export interface PlanLine {
  readonly line: number;
  readonly members: ReadonlyArray<string>;
  readonly subject?: string;
}

export interface FoldBlock {
  readonly members: ReadonlyArray<FoldCommit>;
  readonly subject?: string;
}

export interface FoldGit {
  readonly text: (args: ReadonlyArray<string>, input?: string, env?: NodeJS.ProcessEnv) => string;
  readonly result: (args: ReadonlyArray<string>) => CommandResult;
  /** Runs at an explicit working directory with extra environment; non-zero status is a value, never a throw. */
  readonly run: (
    args: ReadonlyArray<string>,
    options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
  ) => CommandResult;
}

export class FoldRebaseError extends Error {}

/** Flags mirror the sync rebase's configuration (scripts/fork-sync.ts REBASE_CONFIG). */
const REBASE_FLAGS = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "diff.algorithm=histogram",
  "-c",
  "rerere.enabled=true",
];

export interface FoldRebaseRequest {
  readonly base: string;
  readonly head: string;
  /** The exact plan text the run started from; a rerun that differs refuses rather than resuming. */
  readonly planText: string;
  readonly stack: FoldStack;
  /** The blocks at and after the first refusal, in plan order. */
  readonly remaining: ReadonlyArray<FoldBlock>;
  /** Per remaining block: the fold message when a plain pick would keep a different one. */
  readonly amends: ReadonlyArray<string | undefined>;
  /** The fast path's last tip, or the stack base when the run starts in the worktree. */
  readonly onto: string;
}

export interface FoldRebaseStop {
  readonly worktree: string;
  readonly commit: string;
  readonly subject: string;
  readonly unmerged: ReadonlyArray<string>;
  /** The rebase's own output for the stop; conflict chatter the resolver reads. */
  readonly detail: string;
}

export type FoldRebaseOutcome =
  | { readonly status: "applied"; readonly tip: string }
  | ({ readonly status: "stopped" } & FoldRebaseStop);

/** What a kept worktree was built for; a rerun adopts it only on an exact match. */
interface KeptState {
  readonly base: string;
  readonly head: string;
  readonly plan: string;
}

const planDigest = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

const shellQuote = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

export const rebaseRemaining = (git: FoldGit, request: FoldRebaseRequest): FoldRebaseOutcome => {
  const stateDir = NodePath.join(
    git.text(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "fork-fold",
  );
  const worktree = NodePath.join(stateDir, "worktree");
  const state: KeptState = {
    base: request.base,
    head: request.head,
    plan: planDigest(request.planText),
  };

  const must = (args: ReadonlyArray<string>, cwd?: string): string => {
    const result = git.run(args, cwd === undefined ? {} : { cwd });
    if (result.status !== 0 || result.error !== undefined) {
      throw new FoldRebaseError(`${commandText("git", args)} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  };
  // The rebase-merge directory existing under the worktree's git dir is the
  // in-progress probe, the same one the sync driver uses.
  const rebaseMergePath = (): string =>
    NodePath.join(
      must(["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"], worktree),
    );
  const rebaseInProgress = (): boolean => NodeFS.existsSync(rebaseMergePath());

  let fresh = false;
  if (NodeFS.existsSync(worktree)) {
    let kept: KeptState;
    try {
      kept = JSON.parse(
        NodeFS.readFileSync(NodePath.join(stateDir, "state.json"), "utf8"),
      ) as KeptState;
    } catch {
      throw new FoldRebaseError(
        `cannot read the kept fold state at ${NodePath.join(stateDir, "state.json")}; remove ${stateDir} to abandon the kept worktree`,
      );
    }
    if (kept.base !== state.base || kept.head !== state.head || kept.plan !== state.plan)
      throw new FoldRebaseError(
        `the kept worktree at ${worktree} was built for base ${kept.base}, head ${kept.head}, plan ${kept.plan}; rerun that exact apply command, or remove ${stateDir} to abandon it`,
      );
    if (!rebaseInProgress())
      throw new FoldRebaseError(
        `the kept worktree at ${worktree} holds no rebase stop to resume; remove ${stateDir} to abandon it`,
      );
  } else {
    fresh = true;
    git.run(["worktree", "prune"]);
    NodeFS.mkdirSync(stateDir, { recursive: true });
    must(["worktree", "add", "--quiet", "--detach", worktree, request.head]);
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    writeTodo(stateDir, request);
  }

  // The upstream is the parent of the earliest stack-positioned remaining
  // member: every still-unreplayed commit sits inside that range, and commits
  // the fast path already carried stay out of the todo.
  const positions = request.remaining.flatMap((block) =>
    block.members.map((member) =>
      request.stack.commits.findIndex((commit) => commit.sha === member.sha),
    ),
  );
  const earliest = Math.min(...positions);
  const earliestCommit = request.stack.commits[earliest];
  if (earliestCommit === undefined)
    throw new FoldRebaseError("a remaining fold member is not on the stack");
  const upstream = must(["rev-parse", `${earliestCommit.sha}^`]);

  const status = git.run(
    [
      ...REBASE_FLAGS,
      ...(fresh
        ? ["rebase", "-i", "--autosquash", "--rerere-autoupdate", "--onto", request.onto, upstream]
        : ["rebase", "--continue"]),
    ],
    {
      cwd: worktree,
      env:
        fresh === false
          ? { GIT_EDITOR: "true" }
          : {
              GIT_EDITOR: "true",
              GIT_SEQUENCE_EDITOR: `cp ${shellQuote(NodePath.join(stateDir, "todo"))}`,
            },
    },
  );
  if (status.status !== 0) {
    if (!rebaseInProgress())
      throw new FoldRebaseError(
        `git rebase failed without a stop: ${status.stderr.trim() || status.stdout.trim() || "no output"}\nremove ${stateDir} to abandon the kept worktree`,
      );
    return {
      status: "stopped",
      worktree,
      commit: must(["rev-parse", "REBASE_HEAD"], worktree),
      subject: must(["log", "-1", "--format=%s", "REBASE_HEAD"], worktree),
      unmerged: must(["diff", "--name-only", "--diff-filter=U"], worktree)
        .split("\n")
        .filter((path) => path.length > 0),
      detail: status.stderr.trim() || status.stdout.trim(),
    };
  }
  const tip = must(["rev-parse", "HEAD"], worktree);
  must(["worktree", "remove", "--force", worktree]);
  NodeFS.rmSync(stateDir, { recursive: true, force: true });
  return { status: "applied", tip };
};

/** The sequencer's script: pick each lead, fixup its members, amend the folds whose message it reshapes. */
const writeTodo = (stateDir: string, request: FoldRebaseRequest): void => {
  const messagesDir = NodePath.join(stateDir, "messages");
  NodeFS.mkdirSync(messagesDir, { recursive: true });
  const lines: Array<string> = [];
  request.remaining.forEach((block, index) => {
    const [lead, ...rest] = block.members;
    if (lead === undefined) throw new FoldRebaseError("empty plan line");
    lines.push(`pick ${lead.sha}`);
    for (const member of rest) lines.push(`fixup ${member.sha}`);
    const amend = request.amends[index];
    if (amend !== undefined) {
      const messagePath = NodePath.join(messagesDir, `${index}.txt`);
      NodeFS.writeFileSync(messagePath, amend);
      lines.push(`exec git commit --amend --no-verify -F ${shellQuote(messagePath)}`);
    }
  });
  NodeFS.writeFileSync(NodePath.join(stateDir, "todo"), `${lines.join("\n")}\n`);
};
