// @effect-diagnostics nodeBuiltinImport:off - Bot-owned refs are Git plumbing that runs before an Effect runtime exists.

// The bot-owned `refs/fork/*` family carries walk data that is not fork behaviour.
// Each ref is an orphan history the bot appends to and never rebases, so the fork
// series stays free of the rows and caches a rebase would otherwise have to carry.

import { runCommand, runCommandText } from "./fork-command.ts";

/** Ledger of every unblock walk, one JSON file, machine-readable (RSI-Software/t3code-hyprws#476). */
export const CHURN_REF = "refs/fork/churn";
export const CHURN_LEDGER_FILE = "fork-churn.json";

const gitResult = (root: string, args: ReadonlyArray<string>) =>
  runCommand("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });

const gitText = (root: string, args: ReadonlyArray<string>, input?: string): string =>
  runCommandText("git", args, { cwd: root, ...(input === undefined ? {} : { input }) });

const refExists = (root: string, ref: string): boolean =>
  gitResult(root, ["show-ref", "--verify", "--quiet", ref]).status === 0;

/**
 * Bring a bot-owned ref down from origin. It is never rebased, so a forced local
 * update only ever fast-forwards onto the bot's own append.
 */
export const fetchBotRef = (root: string, ref: string): boolean =>
  gitResult(root, ["fetch", "--quiet", "origin", `+${ref}:${ref}`]).status === 0;

/** Resolve a bot-owned ref, fetching once when the checkout has not seen it yet. */
export const resolveBotRef = (root: string, ref: string): string | null => {
  if (!refExists(root, ref)) fetchBotRef(root, ref);
  if (!refExists(root, ref)) return null;
  return gitText(root, ["rev-parse", `${ref}^{commit}`]).trim();
};

/** Read one file out of a bot-owned ref. `null` means the ref or the file is absent. */
export const readBotRefFile = (root: string, ref: string, file: string): string | null => {
  if (resolveBotRef(root, ref) === null) return null;
  const result = gitResult(root, ["show", `${ref}:${file}`]);
  return result.status === 0 && result.error === undefined ? result.stdout : null;
};

const commitBotRef = (root: string, ref: string, tree: string, message: string): string => {
  const parent = resolveBotRef(root, ref);
  if (parent !== null && gitText(root, ["rev-parse", `${ref}^{tree}`]).trim() === tree)
    return parent;
  const commit = gitText(root, [
    "commit-tree",
    tree,
    ...(parent === null ? [] : ["-p", parent]),
    "-m",
    message,
  ]).trim();
  gitText(root, ["update-ref", ref, commit, ...(parent === null ? [] : [parent])]);
  return commit;
};

/** Replace a bot-owned ref's single-file tree. Returns the ref's new commit. */
export const writeBotRefFile = (
  root: string,
  ref: string,
  file: string,
  contents: string,
  message: string,
): string => {
  const blob = gitText(root, ["hash-object", "-w", "--stdin"], contents).trim();
  const tree = gitText(root, ["mktree"], `100644 blob ${blob}\t${file}\n`).trim();
  return commitBotRef(root, ref, tree, message);
};

/** Publish a bot-owned ref. Credentials come from the caller's Git environment. */
export const pushBotRef = (root: string, ref: string): void => {
  gitText(root, ["push", "--quiet", "origin", `${ref}:${ref}`]);
};
