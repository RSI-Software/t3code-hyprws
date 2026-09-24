#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.
// fork job step 5: stale-delete check
// Gate: fork:ci — a commit in base..head deleting an upstream line a later one restores fails.

// Rebase replays each commit, never the net: deleting an upstream line a later
// commit restores leaves the tip equal to upstream yet conflicts on replay.

import { parseArgs } from "./fork-cli.ts";
import { SystemGit } from "./fork-command.ts";
import { systemForkCiGit, type ForkCiGit } from "./fork-ci-flags.ts";

const significant = (line: string): boolean => line.length >= 8 && /[\p{L}\p{N}]/u.test(line);

export const staleDeletes = (
  git: ForkCiGit,
  base: string,
  head: string,
  upstream = "upstream/main",
): ReadonlyArray<string> => {
  const list = (args: ReadonlyArray<string>) => git.run(args).split("\n").filter(Boolean);
  const linesAt = (ref: string, file: string) => {
    const text = git.attempt(["show", `${ref}:${file}`]);
    return text === null ? null : new Set(text.split("\n").map((line) => line.trim()));
  };
  const deleted: Array<readonly [at: number, file: string, line: string]> = [];
  const restoredAt = new Map<string, number>();
  const commits = list(["rev-list", "--reverse", "--no-merges", `${base}..${head}`]);
  commits.forEach((commit, at) => {
    for (const file of list(["diff", "--name-only", "--diff-filter=M", `${commit}^`, commit])) {
      const diff = git.run(["diff", "-U0", `${commit}^`, commit, "--", file]).split("\n");
      // The `---` file header ends at the first hunk.
      for (const change of diff.slice(diff.findIndex((line) => line.startsWith("@@")))) {
        const line = change.slice(1).trim();
        if (!significant(line)) continue;
        if (change.startsWith("-")) deleted.push([at, file, line]);
        if (change.startsWith("+")) restoredAt.set(`${file}\0${line}`, at);
      }
    }
  });
  const hits = new Set<string>();
  for (const [at, file, line] of deleted) {
    if ((restoredAt.get(`${file}\0${line}`) ?? -1) <= at) continue;
    // Files upstream lacks are fork-owned: `linesAt` is null there.
    const [atUpstream, atHead] = [linesAt(upstream, file), linesAt(head, file)];
    if (atUpstream?.has(line) && atHead?.has(line))
      hits.add(`${commits[at]?.slice(0, 10)} ${file}: ${line.slice(0, 80)}`);
  }
  return [...hits];
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  const { values } = parseArgs(argv, { values: ["--base", "--head"] });
  const [base, head] = [values.get("--base") ?? "origin/hyprws", values.get("--head") ?? "HEAD"];
  const hits = staleDeletes(systemForkCiGit(new SystemGit(cwd)), base, head);
  if (hits.length === 0) return 0;
  process.stderr.write(
    `${hits.join("\n")}\na fork commit deleted an upstream line that survives at the tip; fold the restore into this commit (fork-fold) or leave the upstream block alone\n`,
  );
  return 1;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
