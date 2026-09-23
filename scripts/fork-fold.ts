#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone fold tool runs before an Effect runtime exists.
// Gate: local — the fork-fold skill runs it by hand; prove reports, and no workflow invokes it.

// Folds the fork's ahead commits into one-intent commits. The agent picks the
// folds and writes the plan; this script only lists the stack, replays a plan
// onto a detached tip, and proves the new tip against the old one. It holds no
// fold rules: .agents/skills/fork-fold/SKILL.md carries them.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { commitNumstatArguments, parseCommitNumstat } from "./fork-delta.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import { type CommandResult, commandText, runCommand } from "./lib/fork-command.ts";
import {
  bodyProse,
  forkLogArguments,
  type ParsedForkCommit,
  parseForkLog,
} from "./lib/fork-trailers.ts";

const HELP = `Usage: vp run fork:fold <command> [options]

Commands:
  list [--json]            Ahead commits grouped by Fork-Domain, with files
  apply <plan.tsv>         Replay the plan onto a detached tip; prints the tip sha
  prove <old> <new>        Tree-equal, fork:delta --check, and fork:scan on <new>

Options:
  --base <ref>   Upstream base (default: upstream/main)
  --head <ref>   Stack head for list and apply (default: HEAD)
  --json         list: print JSON instead of the table
  -h, --help     Show help

Plan: one line per output commit, tab-separated member shas in stack order.
A last field that is not a sha overrides the first member's subject.
Blank lines and # lines are ignored. Every ahead commit appears exactly once.

Exit 0 passes, 1 fails, 2 is usage.
`;

export interface FoldCommit extends ParsedForkCommit {
  readonly files: ReadonlyArray<string>;
}

export interface FoldStack {
  readonly base: string;
  readonly head: string;
  readonly commits: ReadonlyArray<FoldCommit>;
}

export interface PlanLine {
  readonly line: number;
  readonly members: ReadonlyArray<string>;
  readonly subject?: string;
}

export interface FoldBlock {
  readonly members: ReadonlyArray<FoldCommit>;
  readonly subject?: string;
}

class FoldError extends Error {}

export interface FoldGit {
  readonly text: (args: ReadonlyArray<string>, input?: string, env?: NodeJS.ProcessEnv) => string;
  readonly result: (args: ReadonlyArray<string>) => CommandResult;
}

export const systemFoldGit = (cwd: string): FoldGit => ({
  text: (args, input, env) => {
    const result = runCommand("git", args, {
      cwd,
      ...(input === undefined ? {} : { input }),
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    if (result.status !== 0 || result.error !== undefined) {
      throw new FoldError(`${commandText("git", args)} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  },
  result: (args) => runCommand("git", args, { cwd }),
});

// -- list ---------------------------------------------------------------------

export const readStack = (git: FoldGit, base: string, head: string): FoldStack => {
  const commits = parseForkLog(git.text(forkLogArguments(base, head)));
  const files =
    commits.length === 0
      ? new Map()
      : parseCommitNumstat(git.text(commitNumstatArguments(commits.map(({ sha }) => sha))));
  return {
    base,
    head,
    commits: commits.map((commit) => ({ ...commit, files: files.get(commit.sha)?.files ?? [] })),
  };
};

const LIST_FILES = 5;

export const renderList = (stack: FoldStack): string => {
  const domains = [...new Set(stack.commits.map((commit) => commit.domain ?? "untagged"))];
  const lines = [
    `${stack.commits.length} commits in ${stack.base}..${stack.head}, ${domains.length} domains; # is stack position.`,
  ];
  for (const domain of domains) {
    lines.push("", `## ${domain}`, "");
    stack.commits.forEach((commit, index) => {
      if ((commit.domain ?? "untagged") !== domain) return;
      const marks = [commit.tier ?? "?", ...(commit.repair === undefined ? [] : ["repair"])];
      lines.push(
        `${String(index + 1).padStart(4)}  ${commit.short}  ${marks.join(",")}  ${commit.subject}`,
      );
      for (const path of commit.files.slice(0, LIST_FILES)) lines.push(`        ${path}`);
      if (commit.files.length > LIST_FILES) {
        lines.push(`        +${commit.files.length - LIST_FILES} more (--json)`);
      }
    });
  }
  return `${lines.join("\n")}\n`;
};

// -- apply --------------------------------------------------------------------

const readPlan = (path: string): string => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    throw new FoldError(`cannot read plan ${path}`);
  }
};

const SHA = /^[0-9a-f]{4,40}$/i;

export const parsePlan = (text: string): ReadonlyArray<PlanLine> =>
  text.split("\n").flatMap((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return [];
    const fields = raw
      .split("\t")
      .map((field) => field.trim())
      .filter((field) => field.length > 0);
    const last = fields.at(-1) ?? "";
    const subject = SHA.test(last) ? undefined : last;
    const members = subject === undefined ? fields : fields.slice(0, -1);
    const bad = members.find((member) => !SHA.test(member));
    if (members.length === 0 || bad !== undefined) {
      throw new FoldError(
        `plan line ${index + 1}: expected tab-separated shas, got "${bad ?? raw}"`,
      );
    }
    return [{ line: index + 1, members, ...(subject === undefined ? {} : { subject }) }];
  });

/** Maps each plan member onto the stack; every ahead commit must appear exactly once. */
export const resolvePlan = (
  plan: ReadonlyArray<PlanLine>,
  stack: FoldStack,
): ReadonlyArray<FoldBlock> => {
  const problems: Array<string> = [];
  const used = new Set<string>();
  const blocks = plan.map((line): FoldBlock => {
    const members = line.members.flatMap((member) => {
      const matches = stack.commits.filter((commit) => commit.sha.startsWith(member.toLowerCase()));
      if (matches.length !== 1) {
        problems.push(
          `line ${line.line}: ${member} ${matches.length === 0 ? "is not an ahead commit" : "is ambiguous"}`,
        );
        return [];
      }
      const [commit] = matches as [FoldCommit];
      if (used.has(commit.sha)) problems.push(`line ${line.line}: ${member} is listed twice`);
      used.add(commit.sha);
      return [commit];
    });
    return { members, ...(line.subject === undefined ? {} : { subject: line.subject }) };
  });
  for (const commit of stack.commits) {
    if (!used.has(commit.sha)) problems.push(`${commit.short} ${commit.subject}: missing`);
  }
  if (problems.length > 0)
    throw new FoldError(`plan does not cover the stack:\n${problems.join("\n")}`);
  return blocks;
};

const TIER_RANK: Readonly<Record<string, number>> = { core: 0, qol: 1, bugfix: 2 };
const tierRank = (tier: string | undefined) => TIER_RANK[tier ?? ""] ?? 3;

/** The fold's trailer block: the first member's domain, the strongest tier. */
export const foldTrailers = (members: ReadonlyArray<FoldCommit>): string => {
  const tier = members
    .map((member) => member.tier)
    .toSorted((a, b) => tierRank(a) - tierRank(b))[0];
  const lines = [`Fork-Domain: ${members[0]?.domain ?? ""}`, `Fork-Tier: ${tier ?? ""}`];
  if (tier === "bugfix" || members.some((member) => member.upstreamable !== undefined)) {
    const yes = members.every((member) => member.upstreamable === "yes");
    lines.push(`Fork-Upstreamable: ${yes ? "yes" : "no"}`);
  }
  if (members.every((member) => member.repair !== undefined)) {
    lines.push(`Fork-Repair: ${members.at(-1)?.repair ?? ""}`);
  }
  return lines.join("\n");
};

/** Drops an earlier fold's `Squashes:` list so fork:scan reads only this fold's members. */
const withoutSquashes = (prose: string): string =>
  prose
    .split("\n\n")
    .filter((paragraph) => {
      const lines = paragraph.split("\n").map((line) => line.trim());
      return lines[0] !== "Squashes:" && !lines.every((line) => /^- [0-9a-f]{7,40}\b/.test(line));
    })
    .join("\n\n");

/**
 * One member keeps its message verbatim. A fold keeps the first member's prose,
 * lists every member under `Squashes:` (fork-scan's squashedMembers reads it),
 * and ends with the merged trailers.
 */
export const foldMessage = (block: FoldBlock, firstMessage: string): string => {
  const [first] = block.members;
  if (first === undefined) throw new FoldError("empty plan line");
  const [subjectLine = "", ...rest] = firstMessage.replace(/\r\n/g, "\n").split("\n");
  const subject = block.subject ?? subjectLine;
  if (block.members.length === 1) return [subject, ...rest].join("\n").trimEnd();
  const prose = withoutSquashes(bodyProse(rest.join("\n")));
  return [
    subject,
    ...(prose.length === 0 ? [] : ["", prose]),
    "",
    "Squashes:",
    "",
    ...block.members.map((member) => `- ${member.short} ${member.subject}`),
    "",
    foldTrailers(block.members),
  ].join("\n");
};

/**
 * Replays each block onto the running tip with merge-tree + commit-tree, so no
 * worktree or ref moves. A member that no longer applies cleanly (the plan
 * reordered it past a commit touching the same lines) stops the replay.
 */
export const replay = (
  git: FoldGit,
  stack: FoldStack,
  blocks: ReadonlyArray<FoldBlock>,
): string => {
  const first = stack.commits[0];
  if (first === undefined) throw new FoldError(`no ahead commits in ${stack.base}..${stack.head}`);
  let tip = git.text(["rev-parse", `${first.sha}^`]);
  for (const block of blocks) {
    let scratch = tip;
    let tree = "";
    for (const [index, member] of block.members.entries()) {
      const merged = git.result([
        "merge-tree",
        "--write-tree",
        `--merge-base=${member.sha}^`,
        scratch,
        member.sha,
      ]);
      if (merged.status !== 0) {
        throw new FoldError(
          `${member.short} ${member.subject}: does not apply at its plan position\n${merged.stdout.trim()}`,
        );
      }
      tree = merged.stdout.split("\n")[0] ?? "";
      if (index < block.members.length - 1) {
        scratch = git.text(["commit-tree", tree, "-p", scratch, "-m", "fork-fold scratch"]);
      }
    }
    const lead = block.members[0] as FoldCommit;
    const [name = "", email = "", date = "", message = ""] = git
      .text(["log", "-1", "--format=%an%x00%ae%x00%aI%x00%B", lead.sha])
      .split("\0");
    tip = git.text(
      ["commit-tree", tree, "-p", tip, "-F", "-"],
      `${foldMessage(block, message)}\n`,
      {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
      },
    );
  }
  return tip;
};

// -- prove --------------------------------------------------------------------

export type ProveStep = (command: string, args: ReadonlyArray<string>) => CommandResult;

export const proveChecks = (
  base: string,
  old: string,
  next: string,
  target: string,
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => [
  ["git", ["diff", "--quiet", old, next]],
  ["vp", ["run", "fork:delta", "--check", "--base", base, "--head", next]],
  [
    "vp",
    [
      "run",
      "fork:scan",
      "--head",
      next,
      "--target",
      target,
      "--since",
      target,
      "--replay-of",
      old,
      "--no-typecheck",
    ],
  ],
];

const prove = (git: FoldGit, step: ProveStep, base: string, oldRef: string, newRef: string) => {
  const old = git.text(["rev-parse", "--verify", `${oldRef}^{commit}`]);
  const next = git.text(["rev-parse", "--verify", `${newRef}^{commit}`]);
  const target = git.text(["merge-base", base, next]);
  let failed = 0;
  for (const [command, args] of proveChecks(base, old, next, target)) {
    const result = step(command, args);
    if (result.status !== 0) {
      failed += 1;
      const detail = `${result.stdout}${result.stderr}`.trim();
      if (detail.length > 0) process.stderr.write(`${detail}\n`);
    }
    process.stdout.write(`${commandText(command, args)} → exit ${result.status}\n`);
  }
  if (failed > 0) {
    process.stderr.write(`failed: ${failed} check(s) on ${next.slice(0, 10)}\n`);
    return 1;
  }
  process.stdout.write(`ok: ${next.slice(0, 10)} proves against ${old.slice(0, 10)}\n`);
  return 0;
};

// -- CLI ----------------------------------------------------------------------

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  step: ProveStep = (command, args) => runCommand(command, args, { cwd }),
): number => {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") {
    (subcommand === undefined ? process.stderr : process.stdout).write(HELP);
    return subcommand === undefined ? 2 : 0;
  }
  const git = systemFoldGit(cwd);
  try {
    if (subcommand === "list") {
      const args = parseArgs(rest, { values: ["--base", "--head"], flags: ["--json"] });
      const stack = readStack(
        git,
        args.values.get("--base") ?? "upstream/main",
        args.values.get("--head") ?? "HEAD",
      );
      process.stdout.write(
        args.flags.has("--json") ? `${JSON.stringify(stack, null, 2)}\n` : renderList(stack),
      );
      return 0;
    }
    if (subcommand === "apply") {
      const args = parseArgs(rest, { values: ["--base", "--head"], positionals: 1 });
      const stack = readStack(
        git,
        args.values.get("--base") ?? "upstream/main",
        args.values.get("--head") ?? "HEAD",
      );
      const planPath = args.positionals[0] ?? "";
      const plan = parsePlan(readPlan(NodePath.resolve(cwd, planPath)));
      const blocks = resolvePlan(plan, stack);
      const tip = replay(git, stack, blocks);
      process.stderr.write(
        `${stack.commits.length} commits → ${blocks.length} on ${tip.slice(0, 10)}\n`,
      );
      process.stdout.write(`${tip}\n`);
      return 0;
    }
    if (subcommand === "prove") {
      const args = parseArgs(rest, { values: ["--base"], positionals: 2 });
      const [oldRef = "", newRef = ""] = args.positionals;
      return prove(git, step, args.values.get("--base") ?? "upstream/main", oldRef, newRef);
    }
    throw new UsageError(`unknown command: ${subcommand}`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`fork:fold: ${error.message}\n${HELP}`);
      return 2;
    }
    if (error instanceof FoldError) {
      process.stderr.write(`failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
