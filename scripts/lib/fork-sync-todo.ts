#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Git runs this as the sync rebase's sequence editor.

// The sync rebase's sequence editor. Git autosquash matches a `fixup!` by
// subject prefix, so it cannot fold the `fixup! <owner subject> (#N)` a squash
// landing writes (RSI-Software/t3code-hyprws#1508). The driver resolves every
// fixup to its owner before the rebase starts; this editor then rewrites git's
// generated todo in place, moving each resolved fixup under its owner as
// `fixup`. Rewriting git's own todo, rather than writing one from scratch,
// keeps every other todo decision git makes, such as dropping cherry-picks
// upstream already carries.

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

/** The environment variable carrying `[fixup sha, owner sha]` pairs, oldest fixup first, as JSON. */
export const FIXUP_OWNERS_ENV = "FORK_SYNC_FIXUP_OWNERS";

const TODO_LINE = /^(?:pick|p|fixup|f|squash|s) ([0-9a-f]{4,40})(.*)$/;

/**
 * Move each fixup line under its owner's line as `fixup`, in the pairs' order.
 * A line git already moved is placed again, so the fold never depends on
 * autosquash. A fixup whose owner is absent from the todo stays where it is.
 */
export const placeFixups = (
  todo: string,
  pairs: ReadonlyArray<readonly [fixup: string, owner: string]>,
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
  const placed = lines.filter((_, index) => !moved.some((entry) => entry.at === index));
  return placed
    .flatMap((line) => {
      const sha = shaOf(line);
      const fixups = sha === undefined ? [] : moved.filter((entry) => entry.owner.startsWith(sha));
      return [line, ...fixups.map((entry) => entry.line)];
    })
    .join("\n");
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

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
  NodeFS.writeFileSync(path, placeFixups(NodeFS.readFileSync(path, "utf8"), pairs));
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
