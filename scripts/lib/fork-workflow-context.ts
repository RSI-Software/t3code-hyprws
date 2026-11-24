// @effect-diagnostics nodeBuiltinImport:off - A sync step editing files in its git worktree.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { fromYaml } from "@t3tools/shared/schemaYaml";

import { git, gitResult, lines, type CommandRunner } from "./fork-sync-git.ts";

/** rsi-agent's workflow definitions; each reads its `context:` files at the reviewed sha. */
export const RSI_AGENT_WORKFLOWS = ".rsi-agent/workflows";

const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?<yaml>[\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const decodeFrontmatter = Schema.decodeUnknownSync(
  fromYaml(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The definition's decoded frontmatter; null when it is missing or not YAML. */
const frontmatterOf = (definition: string): Readonly<Record<string, unknown>> | null => {
  const yaml = FRONTMATTER.exec(definition)?.groups?.yaml;
  if (yaml === undefined) return null;
  try {
    return decodeFrontmatter(yaml);
  } catch {
    return null;
  }
};

/** The definition's `context:` paths; none when its frontmatter is missing or not YAML. */
export const contextPaths = (definition: string): ReadonlyArray<string> => {
  const context = frontmatterOf(definition)?.context;
  return Array.isArray(context) ? context.filter((path) => typeof path === "string") : [];
};

const PLAIN_PATH = /^[\w./@+-]+$/;

/** `yaml` with its top-level `context:` key, and the key's indented or `- ` lines, set to `node`. */
const replaceContextNode = (yaml: string, node: string): string => {
  const rows = yaml.split("\n");
  const start = rows.findIndex((row) => row.startsWith("context:"));
  if (start < 0) return yaml;
  let end = start + 1;
  while (end < rows.length && /^(?:[ \t]|-(?:[ \t]|$))/.test(rows[end] ?? "")) end += 1;
  return [...rows.slice(0, start), node, ...rows.slice(end)].join("\n");
};

/**
 * The definition with each `context:` path `exists` misses moved to its `renames` target. Only the
 * `context:` node changes, rewritten as a flow list of the decoded paths; a layout the line edit
 * cannot rewrite cleanly stays as it was, for the scan to fail.
 */
export const followContextRenames = (
  definition: string,
  renames: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
): string => {
  const paths = contextPaths(definition);
  const next = paths.map((path) => (exists(path) ? path : (renames.get(path) ?? path)));
  if (next.every((path, index) => path === paths[index])) return definition;
  const scalars = next.map((path) => (PLAIN_PATH.test(path) ? path : JSON.stringify(path)));
  const edited = definition.replace(FRONTMATTER, (frontmatter: string, yaml: string) => {
    const opening = frontmatter.indexOf("\n") + 1;
    const node = replaceContextNode(yaml, `context: [${scalars.join(", ")}]`);
    return frontmatter.slice(0, opening) + node + frontmatter.slice(opening + yaml.length);
  });
  const expected = JSON.stringify({ ...frontmatterOf(definition), context: next });
  return JSON.stringify(frontmatterOf(edited)) === expected ? edited : definition;
};

/**
 * Point rsi-agent workflow `context:` files upstream renamed between `from` and `to` at their new
 * paths, as one commit in `worktree`. Those lines are the fork's own, so no `# fork-mirror` pin
 * sees the move.
 */
export const commitUpstreamContextRenames = (
  runner: CommandRunner,
  worktree: string,
  from: string,
  to: string,
): boolean => {
  const fields = git(runner, worktree, [
    "diff",
    "-M",
    "--name-status",
    "-z",
    "--diff-filter=R",
    from,
    to,
  ]).split("\0");
  const renames = new Map<string, string>();
  for (let index = 0; index + 2 < fields.length; index += 3)
    renames.set(fields[index + 1] ?? "", fields[index + 2] ?? "");
  if (renames.size === 0) return false;
  const exists = (path: string): boolean =>
    gitResult(runner, worktree, ["cat-file", "-e", `HEAD:${path}`]).status === 0;
  const moved = lines(git(runner, worktree, ["ls-files", "--", RSI_AGENT_WORKFLOWS])).filter(
    (file) => {
      const path = NodePath.join(worktree, file);
      const definition = NodeFS.readFileSync(path, "utf8");
      const next = followContextRenames(definition, renames, exists);
      if (next === definition) return false;
      NodeFS.writeFileSync(path, next);
      return true;
    },
  );
  if (moved.length === 0) return false;
  git(runner, worktree, ["add", "--", ...moved]);
  git(runner, worktree, [
    "commit",
    "--quiet",
    // A path rewrite; the candidate's fork:ci gates it, not hooks needing an install.
    "--no-verify",
    "-m",
    "chore(fork): follow upstream renames in rsi-agent workflow context",
    "-m",
    "Fork-Domain: fork-meta\nFork-Tier: core",
  ]);
  return true;
};
