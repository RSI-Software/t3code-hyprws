#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - This release helper runs before an Effect runtime exists.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import {
  SystemInputCommandRunner as SystemRunner,
  type InputCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";

export {
  SystemInputCommandRunner as SystemRunner,
  type CommandResult,
  type InputCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";

const requireSuccess = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  input?: string,
): string => {
  const result = runner.run(command, args, input);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
};

const lines = (output: string): ReadonlyArray<string> =>
  output
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const stackRangeHash = (patchIds: ReadonlyArray<string>): string => {
  const canonicalPatchIds = patchIds.map((patchId) => `${patchId}\n`).join("");
  const digest = NodeCrypto.createHash("sha256").update(canonicalPatchIds).digest("hex");
  return `sha256:${digest}`;
};

const stablePatchId = (runner: CommandRunner, sha: string): string | null => {
  const patch = requireSuccess(runner, "git", [
    "show",
    "--pretty=format:",
    "--no-ext-diff",
    "--binary",
    sha,
  ]);
  const output = requireSuccess(runner, "git", ["patch-id", "--stable"], patch).trim();
  if (output.length === 0) return null;

  const rows = lines(output);
  const patchId = rows[0]?.split(/\s+/, 1)[0];
  if (rows.length !== 1 || patchId === undefined || !/^[0-9a-f]+$/.test(patchId)) {
    throw new Error(`git patch-id --stable returned invalid output for ${sha}`);
  }
  return patchId;
};

export const resolveStackRangeHash = (
  runner: CommandRunner,
  base: string,
  head: string,
): string => {
  const mergeBase = requireSuccess(runner, "git", ["merge-base", base, head]).trim();
  if (!/^[0-9a-f]+$/i.test(mergeBase)) {
    throw new Error(`git merge-base returned invalid output for ${base} and ${head}`);
  }

  const range = `${mergeBase}..${head}`;
  const merges = lines(requireSuccess(runner, "git", ["rev-list", "--merges", range]));
  if (merges.length > 0) {
    throw new Error(`fork release range ${range} contains merge commits`);
  }

  const commits = lines(
    requireSuccess(runner, "git", ["rev-list", "--reverse", "--no-merges", range]),
  );
  const patchIds = commits.flatMap((sha) => {
    const patchId = stablePatchId(runner, sha);
    return patchId === null ? [] : [patchId];
  });
  return stackRangeHash(patchIds);
};

interface Options {
  readonly base: string;
  readonly head: string;
  readonly githubOutput: boolean;
}

const usage =
  "Usage: node scripts/fork-release-delta-rev.ts [--base <ref>] [--head <ref>] [--github-output]";

export const parseReleaseDeltaOptions = (argv: ReadonlyArray<string>): Options => {
  const parsed = parseArgs(argv, {
    values: ["--base", "--head"],
    flags: ["--github-output", "--help", "-h"],
  });
  if (parsed.flags.has("--help") || parsed.flags.has("-h")) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const base = parsed.values.get("--base") ?? "upstream/main";
  const head = parsed.values.get("--head") ?? "HEAD";
  if (base.length === 0) throw new UsageError("--base requires a ref");
  if (head.length === 0) throw new UsageError("--head requires a ref");
  return { base, head, githubOutput: parsed.flags.has("--github-output") };
};

if (import.meta.main) {
  try {
    const options = parseReleaseDeltaOptions(process.argv.slice(2));
    const revision = resolveStackRangeHash(new SystemRunner(), options.base, options.head);
    if (options.githubOutput) {
      const outputPath = process.env.GITHUB_OUTPUT;
      if (outputPath === undefined || outputPath.length === 0) {
        throw new Error("GITHUB_OUTPUT is required with --github-output");
      }
      NodeFS.appendFileSync(outputPath, `delta_revision=${revision}\n`);
    } else {
      process.stdout.write(`${revision}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
