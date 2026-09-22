#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git helper runs before an Effect runtime exists.
// fork job steps 2 and 5: CI flag derivation
// Gate: none — flag derivation the Check job and fork:ci share; decides scope, never pass or fail.

// The one derivation of the `fork:scan` flags the hyprws CI pull-request Check
// job pins a branch with. The workflow's `Fork ledger` and `Fork rebase scan`
// steps call this file, and `vp run fork:ci` imports the same functions, so
// neither side restates the derivation and a local green run means what CI's
// green means. Before this helper the flags lived only in the workflow's
// shell, and every author invented a weaker invocation locally
// (RSI-Software/t3code-hyprws#1148).

import { UsageError } from "./fork-cli.ts";
import { SystemGit } from "./fork-command.ts";

/** The workflow that consumes the flags. */
export const FORK_CI_WORKFLOW_PATH = ".github/workflows/hyprws-ci.yml";
/** This file's path as the workflow invokes it. */
export const FORK_CI_FLAGS_SCRIPT = "scripts/lib/fork-ci-flags.ts";

const UPSTREAM_MAIN = "upstream/main";
const FORK_TRUNK_REF = "origin/hyprws";

export interface ForkCiFlags {
  /** The branch head the flags are derived for, resolved to a full sha. */
  readonly head: string;
  /** The upstream commit the fork stack sits on. */
  readonly base: string;
  /** Where the scan reports the range from; `head^` when the head has no trunk ancestry below it. */
  readonly since: string;
  /** The scan target: the pinned base, never live `upstream/main`. */
  readonly target: string;
  /** The trunk ref when it resolves, naming the trunk the head is rehearsed against. */
  readonly replayOf: string | null;
}

export interface ForkCiGit {
  /** A git invocation that must succeed; a failure throws. */
  readonly run: (args: ReadonlyArray<string>) => string;
  /** A git invocation allowed to fail; `null` instead of stdout. */
  readonly attempt: (args: ReadonlyArray<string>) => string | null;
}

export const systemForkCiGit = (git: SystemGit): ForkCiGit => ({
  run: (args) => git.run(args),
  attempt: (args) => {
    const result = git.runResult(args);
    return result.status === 0 ? result.stdout : null;
  },
});

// Both fallbacks mean the head has no trunk ancestry to report from: the trunk
// ref is absent, or the head is the trunk tip itself so the merge base is the
// head. The parent then stands in, exactly as the workflow shell used to.
export const deriveForkCiFlags = (git: ForkCiGit, head: string): ForkCiFlags => {
  const base = git.run(["merge-base", UPSTREAM_MAIN, head]).trim();
  const resolvedHead = git.run(["rev-parse", head]).trim();
  const trunkMergeBase = git.attempt(["merge-base", FORK_TRUNK_REF, resolvedHead])?.trim() ?? "";
  const since =
    trunkMergeBase.length === 0 || trunkMergeBase === resolvedHead
      ? `${resolvedHead}^`
      : trunkMergeBase;
  const trunkResolves = git.attempt(["rev-parse", "--verify", "--quiet", FORK_TRUNK_REF]) !== null;
  return {
    head: resolvedHead,
    base,
    since,
    target: base,
    replayOf: trunkResolves ? FORK_TRUNK_REF : null,
  };
};

export const forkScanArguments = (flags: ForkCiFlags): ReadonlyArray<string> => [
  "--head",
  flags.head,
  "--target",
  flags.target,
  "--since",
  flags.since,
  ...(flags.replayOf === null ? [] : ["--replay-of", flags.replayOf]),
  "--no-typecheck",
];

export const FORK_CI_OUTPUT_KEYS = ["head", "base", "since", "target", "replay-of"] as const;

/** GitHub Actions `key=value` lines, one per flag, for `>> "$GITHUB_OUTPUT"`. */
export const renderForkCiOutputs = (flags: ForkCiFlags): string =>
  [
    `head=${flags.head}`,
    `base=${flags.base}`,
    `since=${flags.since}`,
    `target=${flags.target}`,
    `replay-of=${flags.replayOf ?? ""}`,
    "",
  ].join("\n");

/** The scan argv one token per line, for the workflow's `mapfile -t SCAN_ARGS`. */
export const renderForkCiScanArguments = (flags: ForkCiFlags): string =>
  `${forkScanArguments(flags).join("\n")}\n`;

interface Invocation {
  readonly mode: "ledger" | "scan";
  readonly head: string;
}

const parseInvocation = (argv: ReadonlyArray<string>): Invocation => {
  const [mode = "", ...rest] = argv;
  if (mode !== "ledger" && mode !== "scan") throw new UsageError("expected mode: ledger or scan");
  let head = "HEAD";
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (name !== "--head" || value === undefined)
      throw new UsageError(`unexpected argument: ${name ?? ""}`);
    head = value;
  }
  return { mode, head };
};

const HELP = `Usage: node ${FORK_CI_FLAGS_SCRIPT} <ledger|scan> [--head <ref>]

Derives the fork:scan flags the hyprws CI pull-request Check job runs.
The workflow calls this file; vp run fork:ci imports the same functions.

Modes:
  ledger   GitHub output lines: ${FORK_CI_OUTPUT_KEYS.join(", ")}
  scan     the fork:scan argv, one token per line
`;

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const invocation = parseInvocation(argv);
    const root = new SystemGit(cwd).run(["rev-parse", "--show-toplevel"]).trim();
    const git = systemForkCiGit(new SystemGit(root));
    let flags: ForkCiFlags;
    try {
      flags = deriveForkCiFlags(git, invocation.head);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `the derivation reads ${UPSTREAM_MAIN} and ${FORK_TRUNK_REF}; add and fetch those remotes first (the workflow's Fork ledger step provisions them)`,
        { cause: error },
      );
    }
    process.stdout.write(
      invocation.mode === "ledger" ? renderForkCiOutputs(flags) : renderForkCiScanArguments(flags),
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
