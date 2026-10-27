#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request battery runs before an Effect runtime exists.

// The local pre-pull-request battery, each check as hyprws-ci.yml runs it so local green is never
// greener than CI: the Fork ledger delta, stale-delete, and fixup fold checks, the merge-tree job,
// the rebase scan (flags from scripts/lib/fork-ci-flags.ts), knip, read-only `vp check` (never
// `--fix`), typecheck, and the whole scripts suite. Body, builds, and product tests run apart.

import { deriveForkCiFlags, forkScanArguments, systemForkCiGit } from "./lib/fork-ci-flags.ts";
import { runCommand } from "./lib/fork-command.ts";
import { SystemGit } from "./lib/fork-git-reader.ts";

const HELP = `Usage: vp run fork:ci

Runs what the fork's pull-request CI jobs run, in CI's own shape:

  1. the ledger flags, derived by scripts/lib/fork-ci-flags.ts
  2. vp run fork:delta --check --head <head>, the same form the workflow's
     Fork ledger step runs (scripts/fork-delta.ts)
  3. vp run fork:stale-delete --base <since> --head <head>: no branch
     commit deletes an upstream line a later one restores
     (scripts/lib/fork-stale-delete.ts); skipped on a sync candidate,
     whose commits are all replayed
  4. vp run fork:fixup-fold --base <upstream base> --head <head>: every
     fixup! commit folds into the commit it names, proved by a replay
     from the upstream base in a throwaway worktree (scripts/fork-fixup-fold.ts)
  5. bash scripts/fork-merge-tree.sh <head>: no path conflicts against the
     fetched upstream/main that origin/hyprws merges cleanly
  6. vp run fork:scan with exactly those flags (--no-typecheck included),
     which carries the additive gate: files, migrations, tests
     intact (scripts/lib/fork-additive-gate.ts), the hook guard (marked
     insertions only, scripts/lib/fork-hook-guard.ts) and the
     replaced-export / upstream-test authoring findings
     (scripts/fork-scan-authoring.ts)
  7. vp run knip:check, the Check job's unused-code step
  8. vp check, the exact form the workflow's Check step runs
     (scripts/fork-ci.ts never passes --fix: the fixer reformats files
     outside branch scope on this trunk)
  9. vp run typecheck, the Check job's typecheck step
  10. the whole @t3tools/scripts test suite

Stops at the first failing step. Never runs the Body job's squash-body
check, nor the release or sync workflows.
`;

const shortSha = (sha: string): string => sha.slice(0, 7);

/** One fork:ci step: the command, its argv, and the repo root to run it in. */
export type ForkCiStep = (command: string, args: ReadonlyArray<string>, cwd: string) => number;

const systemStep: ForkCiStep = (command, args, cwd) =>
  runCommand(command, args, { cwd, stream: true }).status;

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  step: ForkCiStep = systemStep,
): number => {
  if (argv.some((argument) => argument === "-h" || argument === "--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write("fork:ci: unexpected argument\n");
    return 2;
  }

  const git = new SystemGit(cwd);
  const root = git.run(["rev-parse", "--show-toplevel"]).trim();
  const head = git.run(["rev-parse", "HEAD"]).trim();
  let flags;
  try {
    flags = deriveForkCiFlags(systemForkCiGit(git), head);
  } catch (error) {
    process.stderr.write(
      `fork:ci: ${error instanceof Error ? error.message : String(error)}\n` +
        "the flag derivation needs the upstream remote fetched and origin/hyprws present; CI's Fork ledger step provisions them\n",
    );
    return 1;
  }
  process.stdout.write(
    `fork:ci: head ${shortSha(flags.head)}, base ${shortSha(flags.base)}, since ${shortSha(flags.since)}, target ${shortSha(flags.target)}${
      flags.replayOf === null ? "" : `, replay-of ${flags.replayOf}`
    }\n`,
  );

  const delta = step("vp", ["run", "fork:delta", "--check", "--head", flags.head], root);
  if (delta !== 0) {
    process.stderr.write("fork:ci: delta trailer check failed; fix above before pushing\n");
    return 1;
  }

  // A sync candidate's range is the whole replayed stack, which predates the
  // check; a branch run judges only its own commits.
  const staleDelete = flags.rebased
    ? 0
    : step("vp", ["run", "fork:stale-delete", "--base", flags.since, "--head", flags.head], root);
  if (staleDelete !== 0) {
    process.stderr.write("fork:ci: stale-delete check failed; fix above before pushing\n");
    return 1;
  }

  // The sync folds each fixup! into the commit it names during its rebase, so
  // a fixup that only applies at the branch tip would land green here and
  // then block the next sync (RSI-Software/t3code-hyprws#1554); the replay
  // proves the folds from the same upstream base the sync rebase starts from.
  const fixupFold = step(
    "vp",
    ["run", "fork:fixup-fold", "--base", flags.base, "--head", flags.head],
    root,
  );
  if (fixupFold !== 0) {
    process.stderr.write("fork:ci: fixup fold check failed; fix above before pushing\n");
    return 1;
  }

  const mergeTree = step("bash", ["scripts/fork-merge-tree.sh", flags.head], root);
  if (mergeTree !== 0) {
    process.stderr.write("fork:ci: merge-tree check failed; fix above before pushing\n");
    return 1;
  }

  const scan = step("vp", ["run", "fork:scan", ...forkScanArguments(flags)], root);
  if (scan !== 0) {
    process.stderr.write("fork:ci: rebase scan failed; fix above before pushing\n");
    return 1;
  }

  // The Check job's own order: knip, vp check (never --fix), typecheck.
  const gates: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ["knip", "vp", ["run", "knip:check"]],
    ["vp check", "vp", ["check"]],
    ["typecheck", "vp", ["run", "typecheck"]],
    ["scripts suite", "vp", ["run", "--filter", "@t3tools/scripts", "test"]],
  ];
  for (const [name, command, args] of gates) {
    if (step(command, args, root) !== 0) {
      process.stderr.write(`fork:ci: ${name} failed; fix above before pushing\n`);
      return 1;
    }
  }

  process.stdout.write(
    "fork:ci: ok; the delta check, stale-delete check, fixup fold check, merge-tree check, rebase scan, knip, vp check, typecheck, and scripts suite are green on this head\n",
  );
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
