// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type CwdCommandRunner as CommandRunner } from "./fork-command.ts";
import {
  executeConflictOutcome,
  isUnresolved,
  type ExecutedOutcome,
  type OutcomeSource,
  type UnresolvedOutcome,
} from "./fork-conflict-outcomes.ts";
import { FORK_HOOKS } from "./fork-hooks.ts";

/**
 * The one sequence that decides a conflicted path in the fork's walk, so the walk and the stop
 * census cannot disagree about which paths reach a human. A second copy of this order is the bug
 * RSI-Software/t3code-hyprws#1007 fixed: the census used to count every conflicted path as an
 * operator stop while `fork-sync` resolved most of them mechanically.
 *
 * The order is: a rerere replay of what an earlier walk decided, then the outcome executor's fork
 * doctrine. Only what the executor declines is a human stop. A generated path never arrives here;
 * the walk restores HEAD and regenerates it, and a caller that cannot run the generator has not
 * seen that path resolve.
 */

type ForkHooksManifest = typeof FORK_HOOKS;

/** The stage that owned a conflicted path; `unresolved` is the only one a human owns. */
export type ResolutionStage = "rerere" | OutcomeSource | "unresolved";

export type ConflictResolution =
  | { readonly path: string; readonly stage: "rerere" }
  | {
      readonly path: string;
      readonly stage: OutcomeSource;
      readonly outcome: ExecutedOutcome;
    }
  | {
      readonly path: string;
      readonly stage: "unresolved";
      readonly outcome: UnresolvedOutcome;
    };

export interface ConflictResolutionOptions {
  /**
   * What `git rerere remaining` still lists, or `null` when rerere is not in play for this walk.
   * A path absent from the set may carry a replay; `rerereReplayed` is what proves it.
   */
  readonly rerereRemaining: ReadonlySet<string> | null;
  /** Off only for a caller that cannot run the scoped typecheck; see `executeConflictOutcome`. */
  readonly verifyHookReapply?: boolean;
  readonly manifest?: ForkHooksManifest;
  /**
   * An already-resolved fork-tip commit-ish (`git rev-parse origin/hyprws^{commit}`), threaded
   * explicitly so the hook gate can read markers the replayed commit predates
   * (RSI-Software/t3code-hyprws#1030). Never inferred from ambient rebase state.
   */
  readonly forkTipRef?: string;
}

const CONFLICTED_TEXT = /^(?:<{7}|={7}|>{7})/m;

/**
 * Whether rerere already wrote a usable resolution for this path into the worktree. A path rerere
 * never recorded is absent from `remaining` too, so the set alone proves nothing: what proves the
 * replay is a working-tree file git left without conflict markers and without whitespace damage.
 */
export const rerereReplayed = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  remaining: ReadonlySet<string>,
  env?: NodeJS.ProcessEnv,
): boolean => {
  if (remaining.has(path)) return false;
  let contents: string;
  try {
    contents = NodeFS.readFileSync(NodePath.join(worktree, path), "utf8");
  } catch {
    return false;
  }
  if (CONFLICTED_TEXT.test(contents)) return false;
  return (
    runner.run(
      "git",
      ["-c", "core.commentChar=auto", "diff", "--check", "--", path],
      worktree,
      undefined,
      env,
    ).status === 0
  );
};

/**
 * Decide one conflicted path the way the walk decides it. A resolved path is written and staged by
 * the outcome executor; a `rerere` path is left as it stands, because the caller owns what happens
 * next: the walk stages it, the census stages it and moves on.
 */
export const resolveConflictPath = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  options: ConflictResolutionOptions,
): ConflictResolution => {
  if (
    options.rerereRemaining !== null &&
    rerereReplayed(runner, worktree, path, options.rerereRemaining)
  )
    return { path, stage: "rerere" };
  const outcome = executeConflictOutcome(
    runner,
    worktree,
    path,
    options.manifest ?? FORK_HOOKS,
    options.verifyHookReapply ?? true,
    options.forkTipRef,
  );
  return isUnresolved(outcome)
    ? { path, stage: "unresolved", outcome }
    : { path, stage: outcome.source, outcome };
};
