#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request check runs before an Effect runtime exists.

// The sync folds every `fixup! <owner subject>` into the commit it names
// during its rebase, so a fixup that only applies at the branch tip lands
// green in pull-request CI and then blocks the next sync
// (RSI-Software/t3code-hyprws#1554). This check proves the folds before
// landing: it replays the trunk-plus-branch stack from the upstream base with
// the sync's own fixup placement (`resolveFixups` and the sequence editor),
// in a throwaway worktree, and requires a stop-free replay whose tree equals
// the unfolded tip. Rerere stays off: a recorded resolution would mask a stop
// the replay must report. A stack without fixups skips the worktree entirely.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FIXUP_PREFIX } from "./fork-delta.ts";
import { resolveFixups, type SubjectCommit } from "./fork-sync.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommand, SystemGit } from "./lib/fork-command.ts";
import { FIXUP_OWNERS_ENV, sequenceEditor } from "./lib/fork-sync-todo.ts";

const HELP = `Usage: vp run fork:fixup-fold [--base <ref>] [--head <ref>]

Proves every fixup! commit in <base>..<head> folds into the commit it names.
The sync rebase folds each fixup into its owner, so a fixup that only applies
at the branch tip lands green in pull-request CI and then blocks the next
sync (RSI-Software/t3code-hyprws#1554). The replay runs the stack from
<base> in a throwaway worktree with the sync's own fixup placement and
requires no stops and a tree equal to the unfolded tip. A stack without
fixups skips the replay.
`;

/** The sync rebase's config, minus rerere: the proof must see the raw fold, never a recorded resolution. */
const REPLAY_CONFIG = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "diff.algorithm=histogram",
  "-c",
  "rerere.enabled=false",
  "-c",
  "maintenance.auto=false",
];

const shortSha = (sha: string): string => sha.slice(0, 7);

const stackSubjects = (git: SystemGit, base: string, head: string): ReadonlyArray<SubjectCommit> =>
  git
    .run(["log", "--reverse", "--format=%H%x1f%s", `${base}..${head}`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\u001f");
      return { sha, subject };
    });

/** Abort a mid-stop rebase, then claim the worktree and its admin entry; a leaked replay must not outlive the check. */
const removeReplayWorktree = (git: SystemGit, worktree: string): void => {
  const rebaseMerge = new SystemGit(worktree).runResult([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
  ]);
  if (rebaseMerge.status === 0 && NodeFS.existsSync(rebaseMerge.stdout.trim()))
    new SystemGit(worktree).runResult(["rebase", "--abort"]);
  git.runResult(["worktree", "remove", "--force", worktree]);
  NodeFS.rmSync(worktree, { recursive: true, force: true });
  git.runResult(["worktree", "prune"]);
};

/**
 * Every reason the fixups in `base..head` do not fold at their owners, or an
 * empty array when the stack carries no fixup or every fold replays cleanly.
 * The replay runs in a throwaway worktree under the system temp dir, removed
 * again before this returns.
 */
export const fixupFoldFailures = (
  root: string,
  base: string,
  head: string,
): ReadonlyArray<string> => {
  const git = new SystemGit(root);
  const subjects = stackSubjects(git, base, head);
  if (!subjects.some((commit) => commit.subject.startsWith(FIXUP_PREFIX))) return [];
  const fixups = resolveFixups(subjects);
  if (fixups.refusals.length > 0) return fixups.refusals;

  const nameOf = new Map(subjects.map((commit) => [commit.sha, commit.subject]));
  const subjectOf = (sha: string): string => nameOf.get(sha) ?? "unknown";
  const name = (sha: string): string => `${subjectOf(sha)} (${shortSha(sha)})`;
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fixup-fold-"));
  try {
    git.run(["worktree", "add", "--quiet", "--detach", worktree, head]);
    const replay = new SystemGit(worktree);
    const result = runCommand("git", [...REPLAY_CONFIG, "rebase", "-i", "--autosquash", base], {
      cwd: worktree,
      env: {
        ...process.env,
        // Only the discarded replay commits need an identity; preserve the original authors.
        GIT_COMMITTER_NAME: "Fork Fixup Fold",
        GIT_COMMITTER_EMAIL: "fork-fixup-fold@example.invalid",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: sequenceEditor(),
        [FIXUP_OWNERS_ENV]: JSON.stringify(fixups.owners),
      },
    });
    if (result.status !== 0) {
      const stopped = replay.runResult(["rev-parse", "--verify", "REBASE_HEAD"]);
      const stoppedSha = stopped.status === 0 ? stopped.stdout.trim() : "";
      const pair = fixups.owners.find(([fixup]) => stoppedSha.startsWith(fixup));
      const reason =
        pair === undefined
          ? stoppedSha === ""
            ? "the replay failed before applying a commit"
            : `the replay stopped at ${name(stoppedSha)}`
          : `fixup "${subjectOf(pair[0])}" (${shortSha(pair[0])}) does not fold into its owner "${subjectOf(pair[1])}" (${shortSha(pair[1])}): the replay stopped applying it there`;
      const detail = [result.stderr.trim(), result.error?.message].filter(Boolean).join("\n");
      return [detail === "" ? reason : `${reason}\n${detail}`];
    }
    const replayedTree = replay.run(["rev-parse", "HEAD^{tree}"]).trim();
    const tipTree = git.run(["rev-parse", `${head}^{tree}`]).trim();
    if (replayedTree !== tipTree)
      return [
        `the replayed tip tree ${shortSha(replayedTree)} differs from the unfolded tip tree ${shortSha(tipTree)}: a fixup did not fold`,
      ];
    return [];
  } finally {
    removeReplayWorktree(git, worktree);
  }
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.some((argument) => argument === "-h" || argument === "--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  let base: string;
  let head: string;
  try {
    const { values } = parseArgs(argv, { values: ["--base", "--head"] });
    base = values.get("--base") ?? "upstream/main";
    head = values.get("--head") ?? "HEAD";
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
    return 2;
  }
  const failures = fixupFoldFailures(cwd, base, head);
  if (failures.length === 0) return 0;
  process.stderr.write(
    `${failures.join("\n")}\n` +
      "a fixup! commit must fold into the commit it names: the sync folds each one during its rebase, so a fixup that only applies at the branch tip blocks the next sync; fold it into its owner (fork-fold) or reword it\n",
  );
  return 1;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
