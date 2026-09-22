#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request battery runs before an Effect runtime exists.

// The local pre-pull-request battery: what the fork's pull-request CI runs on
// a branch, in one command. The delta trailer check runs first with the same
// flags the workflow's Fork ledger step uses (`--check --head <head>`), the
// rebase scan consumes the exact flags CI pins, derived by
// scripts/lib/fork-ci-flags.ts — the same helper the workflow calls — and
// the scripts workspace suite runs whole, the way the Test Scripts job
// does, so a local green run cannot be greener than CI
// (RSI-Software/t3code-hyprws#1148). Scope: the hyprws-ci.yml pull-request
// jobs; the Body job's squash-body check needs the pull-request body
// artifact and gates separately, as do the release and sync workflows.

import { deriveForkCiFlags, forkScanArguments, systemForkCiGit } from "./lib/fork-ci-flags.ts";
import { runCommand, SystemGit } from "./lib/fork-command.ts";

const HELP = `Usage: vp run fork:ci

Runs what the fork's pull-request CI jobs run, in CI's own shape:

  1. the ledger flags, derived by scripts/lib/fork-ci-flags.ts
  2. vp run fork:delta --check --head <head>, the same form the workflow's
     Fork ledger step runs (scripts/fork-delta.ts)
  3. vp run fork:scan with exactly those flags (--no-typecheck included),
     which carries step 1 (the additive gate: files, migrations, tests
     intact, scripts/lib/fork-additive-gate.ts), the hook guard (marked
     insertions only, scripts/lib/fork-hook-guard.ts) and the
     replaced-export / upstream-test authoring findings
     (scripts/fork-scan-authoring.ts)
  4. the whole @t3tools/scripts test suite

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

  const scan = step("vp", ["run", "fork:scan", ...forkScanArguments(flags)], root);
  if (scan !== 0) {
    process.stderr.write("fork:ci: rebase scan failed; fix above before pushing\n");
    return 1;
  }

  const suite = step("vp", ["run", "--filter", "@t3tools/scripts", "test"], root);
  if (suite !== 0) {
    process.stderr.write("fork:ci: scripts suite failed; fix above before pushing\n");
    return 1;
  }

  process.stdout.write(
    "fork:ci: ok; the delta check, rebase scan, and scripts suite are green on this head\n",
  );
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
