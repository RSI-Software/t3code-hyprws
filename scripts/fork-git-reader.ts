import { FIXUP_PREFIX, fixupTarget, type ForkCommit } from "./fork-delta.ts";
import type { ScanOptions, ScanRange } from "./fork-scan.ts";
import {
  commitPatchArguments,
  parseCommitPatches,
  significantTestLines,
  upstreamSourceLines,
  upstreamTestPaths,
  type AuthoringGuardInput,
  type CommitPatch,
} from "./fork-scan-authoring.ts";
import { GENERATED_HOOK_PATH, MARKER_CAPABLE_PATH } from "./lib/fork-hook-guard.ts";
import {
  assessForkSupersedes,
  collectForkSupersedes,
  forkTestSibling,
  isForkTestFile,
  upstreamTestPath,
  type SituatedDeclaration,
} from "./lib/fork-supersedes.ts";
import type { GitReader } from "./lib/fork-git-reader.ts";

const RECORD_SEPARATOR = "";

export const commitFilesArguments = (shas: ReadonlyArray<string>) =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--name-only",
    `--format=${RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

export const parseCommitFiles = (raw: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const files = new Map<string, ReadonlyArray<string>>();
  for (const record of raw.replace(/\r\n/g, "\n").split(RECORD_SEPARATOR)) {
    const [sha = "", ...rest] = record.split("\n");
    if (sha.trim().length === 0) continue;
    files.set(
      sha.trim(),
      rest.map((line) => line.trim()).filter((line) => line.length > 0),
    );
  }
  return files;
};

/** Each readable path's text at `tree`, in path order; an unreadable blob leaves no entry. */
const readTexts = (
  git: GitReader,
  tree: string,
  paths: Iterable<string>,
): ReadonlyMap<string, string> => {
  const sorted = [...new Set(paths)].toSorted();
  const blobs = git.readBlobs(sorted.map((path) => `${tree}:${path}`));
  const texts = new Map<string, string>();
  for (const path of sorted) {
    const text = blobs.get(`${tree}:${path}`);
    if (text !== undefined) texts.set(path, text);
  }
  return texts;
};

const readLines = (raw: string): ReadonlyArray<string> =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const readChangedPaths = (
  git: GitReader,
  base: string,
  head: string,
): ReadonlyArray<string> =>
  readLines(git.run(["-c", "core.quotePath=false", "diff", "--name-only", `${base}..${head}`]));

export const resolveRange = (git: GitReader, options: ScanOptions): ScanRange => ({
  base: options.base ?? git.run(["merge-base", options.target, options.head]).trim(),
  head: options.head,
  target: options.target,
});

const addedLinesByPath = (patch: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const additions = new Map<string, Array<string>>();
  let path = "";
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice("+++ b/".length);
      continue;
    }
    if (path.length > 0 && line.startsWith("+") && !line.startsWith("+++")) {
      const lines = additions.get(path) ?? [];
      lines.push(line.slice(1));
      additions.set(path, lines);
    }
  }
  return additions;
};

interface ReplayCounterparts {
  readonly bySubject: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly shas: ReadonlyArray<string>;
}

const replayCounterparts = (git: GitReader, base: string, replayOf: string): ReplayCounterparts => {
  const bySubject = new Map<string, Array<string>>();
  const shas: Array<string> = [];
  for (const record of git
    .run(["log", "--reverse", "--format=%H%x1f%s%x1e", `${base}..${replayOf}`])
    .split("\u001e")) {
    const separator = record.indexOf("\u001f");
    if (separator < 0) continue;
    const sha = record.slice(0, separator).trim();
    const subject = record.slice(separator + 1).trim();
    if (sha.length === 0 || subject.length === 0) continue;
    shas.push(sha);
    const matches = bySubject.get(subject) ?? [];
    matches.push(sha);
    bySubject.set(subject, matches);
  }
  return { bySubject, shas };
};

// A squash lists the originals it replaced under `Squashes:`, one
// `- <sha> <subject>` line per member (fork-development.md). Every member is
// a replay counterpart; the subject alone would match only the first one.
export const squashedMembers = (body: string): ReadonlyArray<string> => {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Squashes:");
  if (start < 0) return [];
  const members: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const member = /^- ([0-9a-f]{7,40})\b/.exec(trimmed)?.[1];
    if (member === undefined) break;
    members.push(member);
  }
  return members;
};

const readSquashedMembers = (
  git: GitReader,
  shas: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const members = new Map<string, ReadonlyArray<string>>();
  if (shas.length === 0) return members;
  for (const record of git
    .run(["log", "--no-walk", "--format=%H%x1f%b%x1e", ...shas])
    .split("\u001e")) {
    const separator = record.indexOf("\u001f");
    if (separator < 0) continue;
    const listed = squashedMembers(record.slice(separator + 1));
    if (listed.length > 0) members.set(record.slice(0, separator).trim(), listed);
  }
  return members;
};

export interface ReplayedCommit extends Pick<ForkCommit, "sha" | "subject"> {
  readonly squashes?: ReadonlyArray<string> | undefined;
}

// A squash resolves every listed member by sha prefix and consumes no subject
// ordinal; anything else matches its subject, oldest first. The sync
// folds each `fixup! <subject>` into the one commit it names, so those fixups
// join that owner's first match.
export const matchReplayCounterparts = (
  commits: ReadonlyArray<ReplayedCommit>,
  counterparts: ReadonlyMap<string, ReadonlyArray<string>>,
  replayShas: ReadonlyArray<string> = [],
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const owners = new Set([...counterparts.keys()].filter((key) => !key.startsWith(FIXUP_PREFIX)));
  const fixupsByOwner = new Map<string, ReadonlyArray<string>>();
  for (const [subject, shas] of counterparts) {
    const named = fixupTarget(subject, owners);
    if (named !== undefined)
      fixupsByOwner.set(named, [...(fixupsByOwner.get(named) ?? []), ...shas]);
  }
  const ordinalBySubject = new Map<string, number>();
  const matched = new Map<string, ReadonlyArray<string>>();
  for (const commit of commits) {
    const ordinal = ordinalBySubject.get(commit.subject) ?? 0;
    const fixups = ordinal === 0 ? (fixupsByOwner.get(commit.subject) ?? []) : [];
    const squashed = (commit.squashes ?? []).flatMap((member) =>
      replayShas.filter((sha) => sha.startsWith(member)),
    );
    if (squashed.length > 0) {
      matched.set(commit.sha, [...squashed, ...fixups]);
      continue;
    }
    ordinalBySubject.set(commit.subject, ordinal + 1);
    const counterpart = counterparts.get(commit.subject)?.[ordinal];
    if (counterpart !== undefined) matched.set(commit.sha, [counterpart, ...fixups]);
  }
  return matched;
};

// `--since` is the outer guard bound. Replay-specific suppression happens at
// line level in the hook guard, so one changed resolution cannot expose the
// same commit's unchanged historical insertions.

// A trailer-free `fixup! <subject>` is scanned as the commit it names, so its
// lines face the same seam rules before the sync folds them in.
export const withFixupOwnerTrailers = (
  commits: ReadonlyArray<ForkCommit>,
): ReadonlyArray<ForkCommit> => {
  const ownerBySubject = new Map(commits.map((commit) => [commit.subject, commit]));
  return commits.map((commit) => {
    const named = fixupTarget(commit.subject, ownerBySubject);
    if (commit.domain !== undefined || named === undefined) return commit;
    const owner = ownerBySubject.get(named);
    if (owner?.domain === undefined) return commit;
    return {
      ...commit,
      domain: owner.domain,
      ...(owner.tier === undefined ? {} : { tier: owner.tier }),
      ...(owner.upstreamable === undefined ? {} : { upstreamable: owner.upstreamable }),
    };
  });
};

export const resolveGuardedCommits = (
  git: Pick<GitReader, "run">,
  options: ScanOptions,
  range: ScanRange,
  commits: ReadonlyArray<ForkCommit>,
): ReadonlyArray<ForkCommit> => {
  const since = options.since;
  const warned =
    since === null ? null : new Set(readLines(git.run(["rev-list", `${since}..${range.head}`])));
  return commits.filter(
    (commit) => commit.domain !== undefined && (warned === null || warned.has(commit.sha)),
  );
};

export const buildGuardInput = (
  git: GitReader,
  options: ScanOptions,
  range: ScanRange,
  commits: ReadonlyArray<ForkCommit>,
  filesBySha: ReadonlyMap<string, ReadonlyArray<string>>,
): AuthoringGuardInput | undefined => {
  const guarded = resolveGuardedCommits(git, options, range, commits);
  const guardCommits = guarded.flatMap((commit) =>
    commit.domain === undefined
      ? []
      : [
          {
            sha: commit.sha,
            short: commit.short,
            domain: commit.domain,
            ...(commit.tier === undefined ? {} : { tier: commit.tier }),
            ...(commit.upstreamable === undefined ? {} : { upstreamable: commit.upstreamable }),
          },
        ],
  );
  const patchesBySha =
    guardCommits.length === 0
      ? new Map<string, CommitPatch>()
      : parseCommitPatches(git.run(commitPatchArguments(guardCommits.map(({ sha }) => sha))));
  const replayAddedLines = new Map<string, ReadonlyMap<string, ReadonlyArray<string>>>();
  if (options.replayOf !== null) {
    const replayBase = git.run(["merge-base", range.target, options.replayOf]).trim();
    const counterparts = replayCounterparts(git, replayBase, options.replayOf);
    const squashes = readSquashedMembers(
      git,
      guarded.map(({ sha }) => sha),
    );
    const matches = matchReplayCounterparts(
      guarded.map((commit) => ({
        sha: commit.sha,
        subject: commit.subject,
        squashes: squashes.get(commit.sha),
      })),
      counterparts.bySubject,
      counterparts.shas,
    );
    for (const commit of guarded) {
      const shas = matches.get(commit.sha);
      if (shas === undefined) continue;
      const added = new Map<string, Array<string>>();
      for (const sha of shas) {
        for (const [path, lines] of addedLinesByPath(
          git.run(["-c", "core.quotePath=false", "show", "--format=", "--unified=0", sha]),
        )) {
          added.set(path, [...(added.get(path) ?? []), ...lines]);
        }
      }
      replayAddedLines.set(commit.sha, added);
    }
  }
  const upstreamFiles =
    guardCommits.length === 0
      ? new Set<string>()
      : new Set(
          readLines(
            git.run(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", range.base]),
          ),
        );
  const upstreamTestFiles =
    guardCommits.length === 0
      ? new Set<string>()
      : new Set(
          readLines(
            git.run(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", range.target]),
          ),
        );
  const upstreamTestTexts =
    guardCommits.length === 0
      ? new Map<string, string>()
      : readUpstreamTestTexts(git, range.target, patchesBySha, upstreamTestFiles);
  return {
    commits: guardCommits,
    filesBySha,
    patchesBySha,
    upstreamFiles,
    upstreamTestFiles,
    upstreamTestLines: readUpstreamLines(
      git,
      range.target,
      patchesBySha,
      upstreamTestFiles,
      upstreamTestPaths,
      () => true,
      significantTestLines,
    ),
    replayAddedLines,
    readCommittedText: (sha, path) => {
      try {
        return git.run(["show", `${sha}:${path}`]);
      } catch {
        return undefined;
      }
    },
    upstreamLines: readUpstreamLines(
      git,
      range.target,
      patchesBySha,
      upstreamFiles,
      (patch) => patch.changedLines.keys(),
      // Test files included: restoring an upstream case is a revert there too.
      (path) => MARKER_CAPABLE_PATH.test(path) && !GENERATED_HOOK_PATH.test(path),
      upstreamSourceLines,
    ),
    upstreamTestTexts,
    headTestTexts:
      guardCommits.length === 0
        ? new Map<string, string>()
        : readTexts(git, range.head, upstreamTestTexts.keys()),
    siblingTexts:
      guardCommits.length === 0
        ? new Map<string, string>()
        : readSiblingTexts(git, range.head, upstreamTestTexts),
  };
};

/**
 * The target-tree text of every upstream file a warned commit touches, so a scan stays proportional.
 * Upstream-test reads removed test lines against it and the hook guard changed source lines; without
 * it each would refuse its own repair (deleting a fork line from an upstream test, or restoring
 * upstream's text byte for byte).
 */
const readUpstreamLines = (
  git: GitReader,
  target: string,
  patchesBySha: ReadonlyMap<string, CommitPatch>,
  upstreamFiles: ReadonlySet<string>,
  selectPaths: (patch: CommitPatch) => Iterable<string>,
  keepPath: (path: string) => boolean,
  readLines: (text: string) => ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const paths = new Set<string>();
  for (const patch of patchesBySha.values())
    for (const path of selectPaths(patch)) {
      if (!upstreamFiles.has(path)) continue;
      if (!keepPath(path)) continue;
      paths.add(path);
    }
  // An unreadable blob leaves no entry, and the rule then refuses every removal in that file.
  const lines = new Map<string, ReadonlySet<string>>();
  for (const [path, text] of readTexts(git, target, paths)) lines.set(path, readLines(text));
  return lines;
};

/**
 * The target-tree text of every upstream test file a warned commit removes a test line from or
 * adds an opener to. The declared-superseded exemption compares by case and the restored-opener
 * exemption by count, so both need the text, not just the line set.
 */
const readUpstreamTestTexts = (
  git: GitReader,
  target: string,
  patchesBySha: ReadonlyMap<string, CommitPatch>,
  upstreamTestFiles: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const paths = new Set<string>();
  for (const patch of patchesBySha.values())
    for (const path of upstreamTestPaths(patch)) if (upstreamTestFiles.has(path)) paths.add(path);
  // An unreadable blob leaves no entry, and the rule then refuses every removal in that file.
  return readTexts(git, target, paths);
};

/**
 * The head-tree text of the fork sibling for every touched upstream test file. Read from the head,
 * never the working tree, so an uncommitted declaration excuses nothing; an unreadable sibling
 * excuses nothing either, because an unread tree is no evidence of a replacement case.
 */
const readSiblingTexts = (
  git: GitReader,
  head: string,
  upstreamTestTexts: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> =>
  // Absent at the head: no declarations to exempt.
  readTexts(git, head, [...upstreamTestTexts.keys()].map(forkTestSibling));

/**
 * Every fork sibling's supersedes declarations at the scanned head, judged against the target tree.
 * Siblings read from the head tree, never the working tree, so CI's synthetic merge checkout works.
 * A sibling whose counterpart the head lacks is skipped; an unreadable blob leaves it refused.
 */
export const readSupersedesAssessment = (
  git: GitReader,
  range: ScanRange,
): {
  readonly supersedes: ReadonlyArray<string>;
  readonly retireCandidates: ReadonlyArray<SituatedDeclaration>;
} => {
  let siblings: ReadonlyArray<string>;
  try {
    siblings = readLines(
      git.run([
        "-c",
        "core.quotePath=false",
        "ls-tree",
        "-r",
        "--name-only",
        range.head,
        "--",
        "apps",
        "packages",
        "scripts",
      ]),
    ).filter(isForkTestFile);
  } catch {
    return { supersedes: [], retireCandidates: [] };
  }
  if (siblings.length === 0) return { supersedes: [], retireCandidates: [] };
  // An unreadable sibling leaves no entry; its declarations stay unread.
  const siblingTexts = readTexts(git, range.head, siblings);
  if (siblingTexts.size === 0) return { supersedes: [], retireCandidates: [] };
  // Candidate upstream texts: every counterpart plus every file a
  // declaration names. A named file outside the sibling's counterpart is
  // how a stale declaration surfaces — read it, then let the assessment
  // refuse it.
  const needed = new Set<string>();
  for (const [sibling, text] of siblingTexts) {
    needed.add(upstreamTestPath(sibling));
    for (const call of collectForkSupersedes(text).declarations) needed.add(call.upstreamPath);
  }
  // Absent from the target tree: the assessment refuses the naming
  // declaration. No entry is the signal.
  const upstreamTexts = readTexts(git, range.target, needed);
  // Merge-base texts for the same paths: the rename check compares base against the assessed tree,
  // so an in-place upstream rename the sibling still carries under the base title reads as
  // undeclared. An unreadable base blob leaves no entry, and the old title-sharing rule stands.
  const baseTexts = readTexts(git, range.base, needed);
  const assessment = assessForkSupersedes(siblingTexts, upstreamTexts, baseTexts);
  return {
    supersedes: [
      ...assessment.refusals,
      ...assessment.undeclared.map(
        ({ sibling, title }) =>
          `${sibling}: case "${title}" contradicts its upstream counterpart with no forkSupersedes declaration; name the upstream case, why the fork differs, and the fork commit`,
      ),
    ],
    retireCandidates: [...assessment.retireCandidates],
  };
};
