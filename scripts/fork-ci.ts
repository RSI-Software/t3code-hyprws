#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request battery runs before an Effect runtime exists.

// The local pre-pull-request battery, each check as hyprws-ci.yml runs it so local green is never
// greener than CI; HELP lists the steps. Body, builds, browser tests, and the non-fork product
// tests run apart.

import {
  deriveForkCiFlags,
  forkScanArguments,
  systemForkCiGit,
  type ForkCiFlags,
} from "./lib/fork-ci-flags.ts";
import { runCommand } from "./lib/fork-command.ts";
import { SystemGit } from "./lib/fork-git-reader.ts";

const HELP = `Usage: vp run fork:ci [--only <step>[,<step>...]]

Runs what the fork's pull-request CI jobs run, in CI's own shape:

  delta         vp run fork:delta --check --head <head>, the same form the
                workflow's Fork ledger step runs (scripts/fork-delta.ts)
  stale-delete  vp run fork:stale-delete --base <since> --head <head>: no
                branch commit deletes an upstream line a later one restores
                (scripts/lib/fork-stale-delete.ts); skipped on a sync
                candidate, whose commits are all replayed
  fixup-fold    vp run fork:fixup-fold --base <upstream base> --head <head>:
                every fixup! commit folds into the commit it names, proved
                by a replay from the upstream base in a throwaway worktree
                (scripts/fork-fixup-fold.ts)
  merge-tree    bash scripts/fork-merge-tree.sh <head>: no path conflicts
                against the fetched upstream/main that origin/hyprws merges
                cleanly
  scan          vp run fork:scan with the ledger flags (--no-typecheck
                included): the additive gate (scripts/lib/fork-additive-gate.ts),
                the hook guard (scripts/lib/fork-hook-guard.ts), and the
                authoring findings (scripts/fork-scan-authoring.ts)
  knip          vp run knip:check, the Check job's unused-code step
  check         vp check, the exact form the workflow's Check step runs; never
                --fix, which reformats files outside branch scope on this trunk
  typecheck     vp run typecheck, the Check job's typecheck step
  scripts       the whole @t3tools/scripts test suite
  fork-tests    every app and package *.fork.test.ts(x) from the repo root,
                which hands each file to its package's config (browser tests
                excluded)

The ledger flags come from scripts/lib/fork-ci-flags.ts. Every step runs,
one at a time, and the summary names every red one; --only reruns just the
named steps. Never runs the Body job's squash-body check, nor the release or
sync workflows.

Exit codes: 0 every run step green, 1 a step red, 2 a usage error.
`;

const shortSha = (sha: string): string => sha.slice(0, 7);

/** One fork:ci command: the command, its argv, and the repo root to run it in. */
export type ForkCiStep = (command: string, args: ReadonlyArray<string>, cwd: string) => number;

type Command = readonly [string, ReadonlyArray<string>];

interface StepContext {
  readonly flags: () => ForkCiFlags;
  readonly git: SystemGit;
}

/** One named step: its commands in order, or null when it does not apply to this head. */
interface StepDefinition {
  readonly name: string;
  readonly commands: (context: StepContext) => ReadonlyArray<Command> | null;
}

// Cheap ledger steps first. Every step runs alone: the heavy ones peak at 3 to 8 GiB each,
// and the sandbox job pod has 8 GiB and two cores.
const STEPS: ReadonlyArray<StepDefinition> = [
  {
    name: "delta",
    commands: ({ flags }) => [["vp", ["run", "fork:delta", "--check", "--head", flags().head]]],
  },
  {
    // A sync candidate's range is the whole replayed stack, which predates the
    // check; a branch run judges only its own commits.
    name: "stale-delete",
    commands: ({ flags }) =>
      flags().rebased
        ? null
        : [["vp", ["run", "fork:stale-delete", "--base", flags().since, "--head", flags().head]]],
  },
  {
    // The sync folds each fixup! into the commit it names during its rebase, so
    // a fixup that only applies at the branch tip would land green here and
    // then block the next sync (RSI-Software/t3code-hyprws#1554); the replay
    // proves the folds from the same upstream base the sync rebase starts from.
    name: "fixup-fold",
    commands: ({ flags }) => [
      ["vp", ["run", "fork:fixup-fold", "--base", flags().base, "--head", flags().head]],
    ],
  },
  {
    name: "merge-tree",
    commands: ({ flags }) => [["bash", ["scripts/fork-merge-tree.sh", flags().head]]],
  },
  {
    name: "scan",
    commands: ({ flags }) => [["vp", ["run", "fork:scan", ...forkScanArguments(flags())]]],
  },
  { name: "knip", commands: () => [["vp", ["run", "knip:check"]]] },
  { name: "check", commands: () => [["vp", ["check"]]] },
  { name: "typecheck", commands: () => [["vp", ["run", "typecheck"]]] },
  {
    name: "scripts",
    commands: () => [["vp", ["run", "--filter", "@t3tools/scripts", "test"]]],
  },
  {
    // The fork's own contracts against upstream drift (a sync candidate's usual red), about 90 s;
    // desktop's tests need Electron installed first, as CI's test jobs do.
    name: "fork-tests",
    commands: ({ git }) => {
      const files = git
        .run([
          "ls-files",
          "--full-name",
          "--",
          ...["apps", "packages"].flatMap((dir) =>
            ["ts", "tsx"].map((ext) => `:(top,glob)${dir}/**/*.fork.test.${ext}`),
          ),
        ])
        .split("\n")
        .filter((path) => path.length > 0);
      // An empty file list would run every test.
      return files.length === 0
        ? null
        : [
            ["vp", ["run", "--filter", "@t3tools/desktop", "ensure:electron"]],
            ["vp", ["test", "run", ...files]],
          ];
    },
  },
];

const STEP_NAMES: ReadonlyArray<string> = STEPS.map((step) => step.name);

/** The steps `--only` names, in battery order; a string when the argv is not a valid selection. */
const selectSteps = (argv: ReadonlyArray<string>): ReadonlyArray<StepDefinition> | string => {
  if (argv.length === 0) return STEPS;
  if (argv[0] !== "--only" || argv.length !== 2) return "unexpected argument";
  const names = argv[1]!.split(",").filter((name) => name.length > 0);
  const unknown = names.filter((name) => !STEP_NAMES.includes(name));
  if (names.length === 0 || unknown.length > 0)
    return `unknown step ${unknown.join(", ") || "''"}; steps: ${STEP_NAMES.join(", ")}`;
  return STEPS.filter((step) => names.includes(step.name));
};

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
  const selected = selectSteps(argv);
  if (typeof selected === "string") {
    process.stderr.write(`fork:ci: ${selected}\n`);
    return 2;
  }

  const git = new SystemGit(cwd);
  const root = git.run(["rev-parse", "--show-toplevel"]).trim();
  const head = git.run(["rev-parse", "HEAD"]).trim();
  // Derived once, and only when a selected step needs it, so `--only typecheck` runs without
  // the upstream remote.
  // A failed derivation is kept, so each ledger step reports it red without rederiving.
  let derived: ForkCiFlags | Error | undefined;
  const flags = (): ForkCiFlags => {
    if (derived instanceof Error) throw derived;
    if (derived === undefined) {
      try {
        derived = deriveForkCiFlags(systemForkCiGit(git), head);
      } catch (error) {
        derived = new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            "the flag derivation needs the upstream remote fetched and origin/hyprws present; CI's Fork ledger step provisions them",
          { cause: error },
        );
        throw derived;
      }
      process.stdout.write(
        `fork:ci: head ${shortSha(derived.head)}, base ${shortSha(derived.base)}, since ${shortSha(derived.since)}, target ${shortSha(derived.target)}${
          derived.replayOf === null ? "" : `, replay-of ${derived.replayOf}`
        }\n`,
      );
    }
    return derived;
  };

  const green: Array<string> = [];
  const red: Array<string> = [];
  for (const definition of selected) {
    let commands;
    try {
      commands = definition.commands({ flags, git });
    } catch (error) {
      process.stderr.write(
        `fork:ci: ${definition.name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      red.push(definition.name);
      continue;
    }
    if (commands === null) continue;
    process.stdout.write(`fork:ci: ${definition.name}\n`);
    const passed = commands.every(([command, args]) => step(command, args, root) === 0);
    (passed ? green : red).push(definition.name);
    if (!passed) process.stderr.write(`fork:ci: ${definition.name} failed\n`);
  }

  if (red.length > 0) {
    process.stderr.write(
      `fork:ci: red on ${shortSha(head)}: ${red.join(", ")}${green.length === 0 ? "" : `; green: ${green.join(", ")}`}\n` +
        `fix them, then rerun the red ones: vp run fork:ci --only ${red.join(",")}\n`,
    );
    return 1;
  }
  process.stdout.write(`fork:ci: ok on ${shortSha(head)}: ${green.join(", ")}\n`);
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
