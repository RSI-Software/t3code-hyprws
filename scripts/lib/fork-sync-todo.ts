#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Git runs this as the sync rebase's sequence editor.

// The sync rebase's sequence editor. Autosquash matches `fixup!` by subject prefix, so it cannot
// fold the `fixup! <owner subject> (#N)` a squash landing writes. The driver resolves fixups first;
// this editor rewrites git's own todo, moving each under its owner with an `exec` that amends in the
// `Squashes:` section, so every other todo decision git made stands.

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/** The environment variable carrying `[fixup sha, owner sha]` pairs, oldest fixup first, as JSON. */
export const FIXUP_OWNERS_ENV = "FORK_SYNC_FIXUP_OWNERS";

/** The environment variable carrying the owner shas with a folded message file, as JSON. */
export const FOLD_MESSAGES_ENV = "FORK_SYNC_FOLD_MESSAGES";

/** Where an owner's folded message lives, under the rebasing worktree's git dir. */
export const foldMessagePath = (owner: string): string => `fork-sync-folds/${owner}.msg`;

/**
 * The amend an owner with a folded message takes. It names the message by git
 * path, not by absolute path, so a todo saved in a partial marker resumes in
 * any checkout that wrote the same message files.
 */
const foldAmend = (owner: string): string =>
  `exec git commit --amend --no-verify -F "$(git rev-parse --git-path ${foldMessagePath(owner)})"`;

/** One fold amend line, as a saved todo must spell it. */
export const FOLD_AMEND_LINE =
  /^exec git commit --amend --no-verify -F "\$\(git rev-parse --git-path fork-sync-folds\/[0-9a-f]{40}\.msg\)"$/;

const TODO_LINE = /^(?:pick|p|fixup|f|squash|s) ([0-9a-f]{4,40})(.*)$/;

/**
 * Move each fixup line under its owner as `fixup`, in pair order, even where git already moved it,
 * so the fold never depends on autosquash. A fixup with no owner in the todo stays put. An owner
 * with a folded message file gets one `exec` after its last fixup that amends in that message.
 */
export const placeFixups = (
  todo: string,
  pairs: ReadonlyArray<readonly [fixup: string, owner: string]>,
  folds: ReadonlySet<string> = new Set(),
): string => {
  const lines = todo.split("\n");
  const shaOf = (line: string): string | undefined => TODO_LINE.exec(line)?.[1];
  const lineOf = (sha: string): number =>
    lines.findIndex((line) => {
      const abbreviated = shaOf(line);
      return abbreviated !== undefined && sha.startsWith(abbreviated);
    });
  const moved = pairs.flatMap(([fixup, owner]) => {
    const at = lineOf(fixup);
    if (at < 0 || lineOf(owner) < 0) return [];
    const [, sha = "", rest = ""] = TODO_LINE.exec(lines[at] ?? "") ?? [];
    return [{ owner, at, line: `fixup ${sha}${rest}` }];
  });
  const amendAfter = (owner: string): string | undefined =>
    folds.has(owner) ? foldAmend(owner) : undefined;
  const placed = lines.filter((_, index) => !moved.some((entry) => entry.at === index));
  return placed
    .flatMap((line) => {
      const sha = shaOf(line);
      const fixups = sha === undefined ? [] : moved.filter((entry) => entry.owner.startsWith(sha));
      return [
        line,
        ...fixups.flatMap((entry, index) => {
          const last = index === fixups.length - 1 || fixups[index + 1]?.owner !== entry.owner;
          const amend = last ? amendAfter(entry.owner) : undefined;
          return amend === undefined ? [entry.line] : [entry.line, amend];
        }),
      ];
    })
    .join("\n");
};

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** `GIT_SEQUENCE_EDITOR` running this module on the todo git hands it. */
export const sequenceEditor = (): string =>
  `${shellQuote(process.execPath)} ${shellQuote(NodeURL.fileURLToPath(import.meta.url))}`;

const run = (args: ReadonlyArray<string>): number => {
  const [path] = args;
  if (path === undefined) {
    process.stderr.write("usage: fork-sync-todo <todo file>\n");
    return 2;
  }
  const pairs = JSON.parse(process.env[FIXUP_OWNERS_ENV] ?? "[]") as Array<[string, string]>;
  const folds = new Set(JSON.parse(process.env[FOLD_MESSAGES_ENV] ?? "[]") as Array<string>);
  NodeFS.writeFileSync(path, placeFixups(NodeFS.readFileSync(path, "utf8"), pairs, folds));
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
