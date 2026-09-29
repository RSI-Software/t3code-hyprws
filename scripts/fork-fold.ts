#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone fold tool runs before an Effect runtime exists.
// Gate: local — the fork-fold skill runs it by hand; prove reports, and no workflow invokes it.

// Folds the fork's ahead commits into one-intent commits. The agent picks the
// folds and writes the plan; this script only lists the stack, replays a plan
// onto a detached tip — merge-tree until the first refused block, then the
// remaining plan as one rebase in a throwaway worktree
// (scripts/lib/fork-fold-rebase.ts) — proves the new tip against the old one,
// and publishes a proven fold on the expected-old lease. It holds no
// fold rules: .agents/skills/fork-fold/SKILL.md carries them.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { commitNumstatArguments, parseCommitNumstat } from "./fork-delta.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import { type CommandResult, commandText, runCommand } from "./lib/fork-command.ts";
import { FoldRebaseError, rebaseRemaining, type FoldRebaseStop } from "./lib/fork-fold-rebase.ts";
import {
  bodyProse,
  forkLogArguments,
  type ParsedForkCommit,
  parseForkLog,
} from "./lib/fork-trailers.ts";
import { HYPRWS_BRANCH, HYPRWS_REF } from "./lib/fork-policy.ts";

const HELP = `Usage: vp run fork:fold <command> [options]

Commands:
  list [--json]            Ahead commits grouped by Fork-Domain, with files
  apply <plan.tsv>         Replay the plan onto a detached tip; prints the tip sha
  prove <old> <new>        Tree-equal, fork:delta --check, and fork:scan on <new>
  publish <old> <new>      Prove, push the expected-old lease, move local hyprws

Options:
  --base <ref>   Upstream base (default: upstream/main)
  --head <ref>   Stack head for list and apply (default: HEAD)
  --json         list: print JSON instead of the table
  -h, --help     Show help

Plan: one line per output commit, tab-separated member shas in stack order.
A last field that is not a sha overrides the first member's subject.
Blank lines and # lines are ignored. Every ahead commit appears exactly once,
and a line's members never mix Fork-Domain values.

apply replays with merge-tree until a block refuses there; from that block on
the remaining plan replays as one git rebase --autosquash in a throwaway
worktree under the git common dir, and a run absorbing a Fork-Repair member
starts there. Each stop names the worktree; resolve and rerun the same apply
command to continue.

Publish refuses unless local hyprws is at <old> with a clean hyprws worktree,
proves, then pushes origin with --force-with-lease=hyprws:<old> — the <old>
resolved at the start, never a re-fetched sha — and only on push exit 0 moves
local hyprws to <new>.

Exit 0 passes, 1 fails, 2 is usage.
`;

export interface FoldCommit extends ParsedForkCommit {
  readonly files: ReadonlyArray<string>;
  /** Full commit message (`%B`), so fold messages can carry each member's PR links. */
  readonly message: string;
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
  /** Runs at an explicit working directory with extra environment; non-zero status is a value, never a throw. */
  readonly run: (
    args: ReadonlyArray<string>,
    options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
  ) => CommandResult;
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
  run: (args, options = {}) =>
    runCommand("git", args, {
      cwd: options.cwd ?? cwd,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    }),
});

// -- list ---------------------------------------------------------------------

const commitMessageArguments = (shas: ReadonlyArray<string>) =>
  ["log", "--no-walk", "--format=%H\u001f%B\u001e", ...shas] as const;

const parseCommitMessages = (raw: string): ReadonlyMap<string, string> => {
  const messages = new Map<string, string>();
  for (const record of raw.replace(/\r\n/g, "\n").split("\u001e")) {
    const normalized = record.replace(/^\n/, "");
    const separator = normalized.indexOf("\u001f");
    if (separator <= 0) continue;
    messages.set(normalized.slice(0, separator), normalized.slice(separator + 1));
  }
  return messages;
};

export const readStack = (git: FoldGit, base: string, head: string): FoldStack => {
  const commits = parseForkLog(git.text(forkLogArguments(base, head)));
  const files =
    commits.length === 0
      ? new Map()
      : parseCommitNumstat(git.text(commitNumstatArguments(commits.map(({ sha }) => sha))));
  const messages =
    commits.length === 0
      ? new Map<string, string>()
      : parseCommitMessages(git.text(commitMessageArguments(commits.map(({ sha }) => sha))));
  return {
    base,
    head,
    commits: commits.map((commit) => ({
      ...commit,
      files: files.get(commit.sha)?.files ?? [],
      message: messages.get(commit.sha) ?? "",
    })),
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
    const domains = [...new Set(members.map((member) => member.domain ?? ""))];
    if (domains.length > 1)
      problems.push(`line ${line.line}: fold mixes Fork-Domain: ${domains.toSorted().join(", ")}`);
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

const FORK_REPO = "RSI-Software/t3code-hyprws";
const FORK_PULL_URL = new RegExp(`https://github\\.com/${FORK_REPO}/pull/(\\d+)`, "g");
const FORK_ITEM_REF = new RegExp(`${FORK_REPO}#(\\d+)`, "g");
/** GitHub squash-merge appends ` (#N)` to a landed pull request's subject. */
const SQUASH_MARKER = /\(#(\d+)\)\s*$/;
/** A `Squashes:` member line; fork-scan's squashedMembers reads the same shape. */
const SQUASH_MEMBER_LINE = /^- [0-9a-f]{7,40}\b/;

/**
 * The fork pull requests a commit cites, as full `RSI-Software/t3code-hyprws#N`
 * refs in first-seen order: its subject's squash marker, a fork pull URL in its
 * message, and refs already listed on an earlier fold's `Squashes:` lines. A
 * bare `#N` in a body is usually an issue (`Closes #N`), and any other repo's
 * ref posts backlinks upstream, so neither is carried.
 */
export const forkPullRequests = (message: string): ReadonlyArray<string> => {
  const normalized = message.replace(/\r\n/g, "\n");
  const [subject = "", ...bodyLines] = normalized.split("\n");
  const refs = new Map<string, string>();
  const add = (n?: string) => {
    if (n !== undefined) refs.set(`${FORK_REPO}#${n}`, `${FORK_REPO}#${n}`);
  };
  add(SQUASH_MARKER.exec(subject.trim())?.[1]);
  for (const match of normalized.matchAll(FORK_PULL_URL)) add(match[1]);
  const start = bodyLines.findIndex((line) => line.trim() === "Squashes:");
  if (start >= 0) {
    for (const line of bodyLines.slice(start + 1)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (!SQUASH_MEMBER_LINE.test(trimmed)) break;
      for (const match of line.matchAll(FORK_ITEM_REF)) add(match[1]);
    }
  }
  return [...refs.keys()];
};

/**
 * One member line: the sha first (squashedMembers reads it), then the subject,
 * then every fork pull request the member cites, rendered full so the link
 * always stays on the fork.
 */
const memberLine = (member: FoldCommit): string => {
  const links = forkPullRequests(member.message)
    .filter((ref) => !member.subject.includes(ref))
    .map((ref) => ` (${ref})`)
    .join("");
  return `- ${member.short} ${member.subject}${links}`;
};

/**
 * One member keeps its message verbatim. A fold keeps the first member's prose,
 * lists every member under `Squashes:` (fork-scan's squashedMembers reads it)
 * with its fork pull request links, and ends with the merged trailers.
 */
export const foldMessage = (block: FoldBlock): string => {
  const [first] = block.members;
  if (first === undefined) throw new FoldError("empty plan line");
  const [subjectLine = "", ...rest] = first.message.replace(/\r\n/g, "\n").split("\n");
  const subject = block.subject ?? subjectLine;
  if (block.members.length === 1) return [subject, ...rest].join("\n").trimEnd();
  const prose = withoutSquashes(bodyProse(rest.join("\n")));
  return [
    subject,
    ...(prose.length === 0 ? [] : ["", prose]),
    "",
    "Squashes:",
    "",
    ...block.members.map(memberLine),
    "",
    foldTrailers(block.members),
  ].join("\n");
};

/**
 * merge-tree replay of one block onto the running tip: the next tip, or the
 * member that no longer applies cleanly there (the plan reordered it past a
 * commit touching the same lines) and hands the run to the worktree fallback.
 */
const fastBlock = (
  git: FoldGit,
  tip: string,
  block: FoldBlock,
): { readonly tip: string } | { readonly refused: FoldCommit } => {
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
    if (merged.status !== 0) return { refused: member };
    tree = merged.stdout.split("\n")[0] ?? "";
    if (index < block.members.length - 1) {
      scratch = git.text(["commit-tree", tree, "-p", scratch, "-m", "fork-fold scratch"]);
    }
  }
  const lead = block.members[0] as FoldCommit;
  const [name = "", email = "", date = ""] = git
    .text(["log", "-1", "--format=%an%x00%ae%x00%aI", lead.sha])
    .split("\0");
  return {
    tip: git.text(["commit-tree", tree, "-p", tip, "-F", "-"], `${foldMessage(block)}\n`, {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
    }),
  };
};

/**
 * Per remaining block, the fold message when a plain pick would keep a
 * different one (any fold, or a subject override); the rebase amends those
 * picks through `exec`. The message function is the single shape, so a fold
 * reads the same from either path.
 */
const amendMessages = (
  git: FoldGit,
  blocks: ReadonlyArray<FoldBlock>,
): ReadonlyArray<string | undefined> =>
  blocks.map((block) => {
    const [lead] = block.members;
    if (lead === undefined) throw new FoldError("empty plan line");
    const raw = git.text(["log", "-1", "--format=%B", lead.sha]);
    const folded = foldMessage(block);
    return folded === raw.replace(/\r\n/g, "\n").trimEnd() ? undefined : `${folded}\n`;
  });

export type FoldReplay =
  | { readonly status: "applied"; readonly tip: string }
  | {
      readonly status: "stopped";
      readonly stop: FoldRebaseStop;
      /** The member merge-tree refused; absent when the run started in the worktree. */
      readonly refused?: { readonly short: string; readonly subject: string };
    };

/**
 * Replays the plan onto a detached tip: merge-tree while blocks apply cleanly,
 * then one rebase of the remaining plan in a throwaway worktree. A run that
 * absorbs a repair (a Fork-Repair member) starts in the worktree. Moves no
 * ref either way; a stopped replay reports the worktree and resumes on rerun.
 */
export const replay = (
  git: FoldGit,
  stack: FoldStack,
  blocks: ReadonlyArray<FoldBlock>,
  planText: string,
): FoldReplay => {
  const first = stack.commits[0];
  if (first === undefined) throw new FoldError(`no ahead commits in ${stack.base}..${stack.head}`);
  const start = git.text(["rev-parse", `${first.sha}^`]);
  const fallback = (
    remaining: ReadonlyArray<FoldBlock>,
    onto: string,
    refused?: { readonly short: string; readonly subject: string },
  ): FoldReplay => {
    const outcome = rebaseRemaining(git, {
      base: stack.base,
      head: stack.head,
      planText,
      stack,
      remaining,
      amends: amendMessages(git, remaining),
      onto,
    });
    // The rebase can finish without stopping where merge-tree refused — the
    // sequencer resolves some shapes git's merge cannot.
    return outcome.status === "applied"
      ? outcome
      : {
          status: "stopped",
          stop: outcome,
          ...(refused === undefined ? {} : { refused }),
        };
  };
  if (blocks.some((block) => block.members.some((member) => member.repair !== undefined))) {
    return fallback(blocks, start);
  }
  let tip = start;
  for (const [index, block] of blocks.entries()) {
    const fast = fastBlock(git, tip, block);
    if ("refused" in fast) {
      return fallback(blocks.slice(index), tip, {
        short: fast.refused.short,
        subject: fast.refused.subject,
      });
    }
    tip = fast.tip;
  }
  return { status: "applied", tip };
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

// -- publish ------------------------------------------------------------------

/**
 * The worktree with hyprws checked out — usually the main checkout — or
 * undefined when checked out nowhere, so there is no worktree tree to dirty.
 */
const trunkWorktree = (git: FoldGit): string | undefined => {
  for (const block of git.text(["worktree", "list", "--porcelain"]).split("\n\n")) {
    const [head = "", ...rest] = block.split("\n");
    if (head.startsWith("worktree ") && rest.includes(`branch ${HYPRWS_REF}`))
      return head.slice("worktree ".length);
  }
  return undefined;
};

/**
 * Publishes a proven fold: the local trunk must sit at <old> on a clean tree,
 * the fold must prove, then the push carries the expected-old lease — the
 * <old> sha resolved here, never a re-fetched one — so a remote that moved
 * since the run started refuses while the local branch stays untouched.
 */
const publish = (git: FoldGit, step: ProveStep, base: string, oldRef: string, newRef: string) => {
  const old = git.text(["rev-parse", "--verify", `${oldRef}^{commit}`]);
  const next = git.text(["rev-parse", "--verify", `${newRef}^{commit}`]);
  const local = git.text(["rev-parse", "--verify", `${HYPRWS_REF}^{commit}`]);
  if (local !== old) {
    process.stderr.write(
      `refused: local ${HYPRWS_BRANCH} is at ${local.slice(0, 10)}, not ${old.slice(0, 10)}\n`,
    );
    return 1;
  }
  // The tree that matters is the one where hyprws is checked out — usually the
  // main checkout — not whichever checkout invoked publish. Checked out
  // nowhere leaves no worktree tree to dirty, so the check is skipped.
  const trunkTree = trunkWorktree(git);
  if (trunkTree !== undefined) {
    const status = git.result(["-C", trunkTree, "status", "--porcelain"]);
    if (status.status !== 0 || status.stdout.trim().length > 0) {
      process.stderr.write(`refused: the ${HYPRWS_BRANCH} worktree is not clean\n${status.stdout}`);
      return 1;
    }
  }
  if (prove(git, step, base, old, next) !== 0) return 1;
  const pushed = step("git", [
    "push",
    "origin",
    `${next}:${HYPRWS_BRANCH}`,
    `--force-with-lease=${HYPRWS_BRANCH}:${old}`,
  ]);
  const pushDetail = `${pushed.stdout}${pushed.stderr}`.trim();
  if (pushDetail.length > 0) process.stdout.write(`${pushDetail}\n`);
  if (pushed.status !== 0) {
    process.stderr.write(
      `refused: origin did not accept the lease ${HYPRWS_BRANCH}:${old.slice(0, 10)}; local ${HYPRWS_BRANCH} kept\n`,
    );
    return 1;
  }
  // hyprws is usually checked out in the main checkout; moving the ref under a
  // checkout is safe only because prove guarantees the fold is tree-equal, so
  // the worktree, index, and any state at <old> read identically at <new>.
  const moved = git.result(["update-ref", HYPRWS_REF, next, old]);
  if (moved.status !== 0) {
    process.stderr.write(
      `failed: local ${HYPRWS_BRANCH} moved during publish: ${moved.stderr.trim()}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `published: ${next.slice(0, 10)} → origin/${HYPRWS_BRANCH} on lease ${old.slice(0, 10)}; local ${HYPRWS_BRANCH} moved\n`,
  );
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
      const planText = readPlan(NodePath.resolve(cwd, planPath));
      const plan = parsePlan(planText);
      const blocks = resolvePlan(plan, stack);
      const outcome = replay(git, stack, blocks, planText);
      if (outcome.status === "stopped") {
        process.stderr.write(
          [
            ...(outcome.refused === undefined
              ? []
              : [
                  `merge-tree refused ${outcome.refused.short} ${outcome.refused.subject}; the remaining plan moved to a rebase in ${outcome.stop.worktree}`,
                ]),
            `stopped: ${outcome.stop.commit.slice(0, 10)} ${outcome.stop.subject}`,
            ...(outcome.stop.unmerged.length === 0
              ? []
              : [`unmerged: ${outcome.stop.unmerged.join(", ")}`]),
            ...(outcome.stop.detail.length === 0 ? [] : [outcome.stop.detail]),
            "resolve in the worktree, then rerun this apply command to continue",
            "",
          ].join("\n"),
        );
        return 1;
      }
      process.stderr.write(
        `${stack.commits.length} commits → ${blocks.length} on ${outcome.tip.slice(0, 10)}\n`,
      );
      process.stdout.write(`${outcome.tip}\n`);
      return 0;
    }
    if (subcommand === "prove") {
      const args = parseArgs(rest, { values: ["--base"], positionals: 2 });
      const [oldRef = "", newRef = ""] = args.positionals;
      return prove(git, step, args.values.get("--base") ?? "upstream/main", oldRef, newRef);
    }
    if (subcommand === "publish") {
      const args = parseArgs(rest, { values: ["--base"], positionals: 2 });
      const [oldRef = "", newRef = ""] = args.positionals;
      return publish(git, step, args.values.get("--base") ?? "upstream/main", oldRef, newRef);
    }
    throw new UsageError(`unknown command: ${subcommand}`);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`fork:fold: ${error.message}\n${HELP}`);
      return 2;
    }
    if (error instanceof FoldError || error instanceof FoldRebaseError) {
      process.stderr.write(`failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
