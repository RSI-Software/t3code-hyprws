#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request battery runs before an Effect runtime exists.
// fork job steps 3 and 5: the CI battery
// Gate: local — the pre-pull-request battery, run by hand; no workflow invokes it, so it blocks nothing by itself.

// The local pre-pull-request battery: what the fork's pull-request CI runs on
// a branch, in one command. The delta trailer check runs first with the same
// flags the workflow's Fork ledger step uses (`--check --head <head>`), the
// rebase scan consumes the exact flags CI pins, derived by
// scripts/lib/fork-ci-flags.ts — the same helper the workflow calls — the
// read-only `vp check` runs in the exact form of the workflow's Check step
// (never `--fix`, which reformats files outside branch scope on this trunk),
// and the scripts workspace suite runs whole, the way the Test Scripts job
// does, so a local green run cannot be greener than CI
// (RSI-Software/t3code-hyprws#1148). Scope: the Fork ledger delta check,
// the Fork stale-delete check, the Fork rebase scan, the `vp check` step,
// and the Test Scripts job of hyprws-ci.yml; the Body job's squash-body
// check needs the pull-request body artifact and gates separately, as do
// knip, typecheck, the desktop build, the product test jobs, and the
// release and sync workflows.

import { deriveForkCiFlags, forkScanArguments, systemForkCiGit } from "./lib/fork-ci-flags.ts";
import { runCommand, SystemGit } from "./lib/fork-command.ts";

const HELP = `Usage: vp run fork:ci [--since <ref>]

Runs what the fork's pull-request CI jobs run, in CI's own shape:

  1. the ledger flags, derived by scripts/lib/fork-ci-flags.ts
  2. vp run fork:delta --check --head <head>, the same form the workflow's
     Fork ledger step runs (scripts/fork-delta.ts)
  3. vp run fork:stale-delete --base <since> --head <head>: no branch
     commit deletes an upstream line a later one restores
     (scripts/lib/fork-stale-delete.ts); skipped under --since
  4. vp run fork:scan with exactly those flags (--no-typecheck included),
     which carries the additive gate: files, migrations, tests
     intact (scripts/lib/fork-additive-gate.ts), the hook guard (marked
     insertions only, scripts/lib/fork-hook-guard.ts) and the
     replaced-export / upstream-test authoring findings
     (scripts/fork-scan-authoring.ts)
  5. vp check, the exact form the workflow's Check step runs
     (scripts/fork-ci.ts never passes --fix: the fixer reformats files
     outside branch scope on this trunk)
  6. the whole @t3tools/scripts test suite

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
  const sinceArg = argv.indexOf("--since");
  if (sinceArg !== -1 && argv.length <= sinceArg + 1) {
    process.stderr.write("fork:ci: --since requires a value\n");
    return 2;
  }
  const sinceOverride = sinceArg === -1 ? undefined : argv[sinceArg + 1];
  if (sinceArg !== -1 && argv.length !== sinceArg + 2) {
    process.stderr.write("fork:ci: unexpected argument\n");
    return 2;
  }

  const git = new SystemGit(cwd);
  const root = git.run(["rev-parse", "--show-toplevel"]).trim();
  const head = git.run(["rev-parse", "HEAD"]).trim();
  let flags;
  try {
    // Only the sync battery passes --since (its rehearsal target tag), so a
    // rehearsed head guards the replayed fork delta; the pull-request path
    // keeps the merge-base derivation.
    flags = deriveForkCiFlags(
      systemForkCiGit(git),
      head,
      sinceOverride === undefined ? {} : { since: sinceOverride },
    );
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

  // The sync battery's --since spans the whole replayed stack, which predates
  // the check; a branch run judges only its own commits.
  const staleDelete =
    sinceOverride === undefined
      ? step("vp", ["run", "fork:stale-delete", "--base", flags.since, "--head", flags.head], root)
      : 0;
  if (staleDelete !== 0) {
    process.stderr.write("fork:ci: stale-delete check failed; fix above before pushing\n");
    return 1;
  }

  const scan = step("vp", ["run", "fork:scan", ...forkScanArguments(flags)], root);
  if (scan !== 0) {
    process.stderr.write("fork:ci: rebase scan failed; fix above before pushing\n");
    return 1;
  }

  const check = step("vp", ["check"], root);
  if (check !== 0) {
    process.stderr.write("fork:ci: vp check failed; fix above before pushing\n");
    return 1;
  }

  const suite = step("vp", ["run", "--filter", "@t3tools/scripts", "test"], root);
  if (suite !== 0) {
    process.stderr.write("fork:ci: scripts suite failed; fix above before pushing\n");
    return 1;
  }

  process.stdout.write(
    "fork:ci: ok; the delta check, stale-delete check, rebase scan, vp check, and scripts suite are green on this head\n",
  );
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
