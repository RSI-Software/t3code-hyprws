#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request battery runs before an Effect runtime exists.

// The local pre-pull-request battery: what the fork's pull-request CI runs on
// a branch, in one command. The rebase scan consumes the exact flags CI pins,
// derived by scripts/lib/fork-ci-flags.ts — the same helper the workflow calls
// — and the scripts workspace suite runs whole, the way the Test Scripts job
// does, so a local green run cannot be greener than CI
// (RSI-Software/t3code-hyprws#1148). Scope: the hyprws-ci.yml pull-request
// jobs; the release and sync workflows gate elsewhere.

import { deriveForkCiFlags, forkScanArguments, systemForkCiGit } from "./lib/fork-ci-flags.ts";
import { checkAdditive, renderAdditiveFindings } from "./lib/fork-additive-gate.ts";
import { runCommand, SystemCommandRunner, SystemGit } from "./lib/fork-command.ts";

const HELP = `Usage: vp run fork:ci

Runs what the fork's pull-request CI jobs run, in CI's own shape:

  1. the additive gate: the head tree is a pure addition on upstream base
     (scripts/lib/fork-additive-gate.ts: files, migrations, tests)
  2. the ledger flags, derived by scripts/lib/fork-ci-flags.ts
  3. vp run fork:scan with exactly those flags (--no-typecheck included),
     which carries the hook guard (marked insertions only,
     scripts/lib/fork-hook-guard.ts) and the replaced-export /
     upstream-test authoring findings (scripts/fork-scan-authoring.ts)
  4. the whole @t3tools/scripts test suite

Stops at the first failing step. Never runs the release or sync workflows.
`;

const shortSha = (sha: string): string => sha.slice(0, 7);

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
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

  const additive = checkAdditive(
    new SystemCommandRunner(),
    root,
    // Base + since, never live upstream: files and migrations read against
    // the pinned base, tests against the since tree so only new test loss
    // fires. Replay runs prove nothing new and skip the tests check.
    flags.replayOf === null
      ? { base: flags.base, since: flags.since }
      : { base: flags.base, since: null },
    { head: flags.head },
  );
  if (additive.length > 0) {
    for (const line of renderAdditiveFindings(additive)) process.stderr.write(`${line}\n`);
    process.stderr.write("fork:ci: additive gate failed; fix above before pushing\n");
    return 1;
  }
  process.stdout.write("fork:ci: additive gate ok\n");

  const scan = runCommand("vp", ["run", "fork:scan", ...forkScanArguments(flags)], {
    cwd: root,
    stream: true,
  });
  if (scan.status !== 0) {
    process.stderr.write("fork:ci: rebase scan failed; fix above before pushing\n");
    return 1;
  }

  const suite = runCommand("vp", ["run", "--filter", "@t3tools/scripts", "test"], {
    cwd: root,
    stream: true,
  });
  if (suite.status !== 0) {
    process.stderr.write("fork:ci: scripts suite failed; fix above before pushing\n");
    return 1;
  }

  process.stdout.write("fork:ci: ok; the pull-request checks are green on this head\n");
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
