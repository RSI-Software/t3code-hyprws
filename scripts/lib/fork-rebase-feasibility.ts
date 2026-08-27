// Read-only merge feasibility for the fork rebase orientation report.

import { normalizeTrailerValue } from "./fork-trailers.ts";

const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";
const OBJECT_ID = "[0-9a-f]{40,64}";
const TREE_LINE = new RegExp(`^${OBJECT_ID}$`);
const STAGE_LINE = new RegExp(`^[0-7]{6} ${OBJECT_ID} [123]\\t(?<path>.+)$`);

export interface GitCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface FeasibilityGit {
  readonly run: (args: ReadonlyArray<string>) => string;
  readonly runResult: (args: ReadonlyArray<string>) => GitCommandResult;
}

export interface FeasibilityCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly tags: ReadonlyArray<string>;
}

export interface FeasibilityBoundaryChange extends FeasibilityCommit {
  readonly filesAdded: ReadonlyArray<string>;
}

export interface FeasibilityConflict {
  readonly path: string;
  readonly hunkCount: number;
  readonly introducingForkCommit: {
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly domain: string | null;
    readonly tier: string | null;
  };
}

export interface ForkRebaseFeasibility {
  readonly ffBoundary: {
    readonly upstreamCommitCount: number;
    readonly cleanCommitCount: number;
    readonly firstConflict: FeasibilityCommit | null;
    readonly changes: ReadonlyArray<FeasibilityBoundaryChange>;
  };
  readonly conflicts: ReadonlyArray<FeasibilityConflict>;
  readonly overlap: {
    readonly upstreamChanged: number;
    readonly forkChanged: number;
    readonly overlap: number;
    readonly hardConflict: number;
    readonly automerged: ReadonlyArray<string>;
  };
}

interface MergeTreeResult {
  readonly tree: string;
  readonly conflicts: ReadonlyArray<string>;
}

interface ForkStackCommit {
  readonly sha: string;
  readonly subject: string;
  readonly domain: string | null;
  readonly tier: string | null;
}

export class MergeTreeError extends Error {
  readonly exitCode: number | null;

  constructor(left: string, right: string, result: GitCommandResult) {
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
    super(
      `git merge-tree failed for ${left} and ${right} with exit code ${String(result.status)}${
        detail.length > 0 ? `: ${detail}` : ""
      }`,
    );
    this.name = "MergeTreeError";
    this.exitCode = result.status;
  }
}

export const parseMergeTreeResult = (
  left: string,
  right: string,
  result: GitCommandResult,
): MergeTreeResult => {
  if (result.status === null || result.status > 1 || result.error !== undefined) {
    throw new MergeTreeError(left, right, result);
  }

  const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
  const tree = lines[0] ?? "";
  if (!TREE_LINE.test(tree)) {
    throw new Error(`git merge-tree returned no result tree for ${left} and ${right}`);
  }

  const conflicts = new Set<string>();
  for (const line of lines.slice(1)) {
    const match = STAGE_LINE.exec(line);
    if (match?.groups?.path !== undefined) conflicts.add(match.groups.path);
  }
  if (result.status === 0 && conflicts.size > 0) {
    throw new Error(
      `git merge-tree reported conflict stages with a clean exit for ${left} and ${right}`,
    );
  }
  if (result.status === 1 && conflicts.size === 0) {
    throw new Error(
      `git merge-tree reported a conflict without conflict stages for ${left} and ${right}`,
    );
  }
  return { tree, conflicts: [...conflicts].toSorted() };
};

export const runMergeTree = (
  git: Pick<FeasibilityGit, "runResult">,
  left: string,
  right: string,
): MergeTreeResult =>
  parseMergeTreeResult(
    left,
    right,
    git.runResult(["-c", "core.quotePath=false", "merge-tree", "--write-tree", left, right]),
  );

const parseFirstParentCommits = (raw: string): ReadonlyArray<Omit<FeasibilityCommit, "tags">> =>
  raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = ""] = record.replace(/\n+$/, "").split(FIELD_SEPARATOR);
      if (sha.length === 0) throw new Error("git log returned a malformed upstream commit");
      return { sha, shortSha: sha.slice(0, 7), subject };
    });

const tagsAt = (git: Pick<FeasibilityGit, "run">, sha: string): ReadonlyArray<string> =>
  git
    .run(["tag", "--points-at", sha, "--list", "v*", "--sort=version:refname"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && !/-hyprws\.\d+$/.test(tag));

const readUpstreamCommits = (
  git: Pick<FeasibilityGit, "run">,
  baseSha: string,
  targetSha: string,
): ReadonlyArray<FeasibilityCommit> =>
  parseFirstParentCommits(
    git.run([
      "log",
      "--first-parent",
      "--reverse",
      `--format=%H${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
      `${baseSha}..${targetSha}`,
    ]),
  ).map((commit) => ({ ...commit, tags: tagsAt(git, commit.sha) }));

const parseForkStack = (raw: string): ReadonlyArray<ForkStackCommit> =>
  raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", subject = "", domain = "", tier = ""] = record
        .replace(/\n+$/, "")
        .split(FIELD_SEPARATOR);
      if (sha.length === 0) throw new Error("git log returned a malformed fork commit");
      return {
        sha,
        subject,
        domain: normalizeTrailerValue(domain) ?? null,
        tier: normalizeTrailerValue(tier) ?? null,
      };
    });

const readForkStack = (
  git: Pick<FeasibilityGit, "run">,
  sourceSha: string,
): ReadonlyArray<ForkStackCommit> =>
  parseForkStack(
    git.run([
      "log",
      "--reverse",
      "--topo-order",
      `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%(trailers:key=Fork-Domain,valueonly)${FIELD_SEPARATOR}%(trailers:key=Fork-Tier,valueonly)${RECORD_SEPARATOR}`,
      `upstream/main..${sourceSha}`,
    ]),
  );

const readChangedPaths = (
  git: Pick<FeasibilityGit, "run">,
  baseSha: string,
  headSha: string,
): ReadonlyArray<string> =>
  git
    .run(["-c", "core.quotePath=false", "diff", "--name-only", "-z", `${baseSha}..${headSha}`])
    .split("\0")
    .filter(Boolean)
    .toSorted();

const markerCount = (contents: string): number => contents.match(/^<<<<<<< /gm)?.length ?? 0;

export const buildFeasibility = (
  git: FeasibilityGit,
  sourceSha: string,
  targetSha: string,
  baseSha: string,
): ForkRebaseFeasibility => {
  const cache = new Map<string, MergeTreeResult>();
  const mergeTree = (left: string, right: string): MergeTreeResult => {
    const key = `${left}\0${right}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = runMergeTree(git, left, right);
    cache.set(key, result);
    return result;
  };

  const upstreamCommits = readUpstreamCommits(git, baseSha, targetSha);
  const changes: Array<FeasibilityBoundaryChange> = [];
  let previousConflicts = new Set<string>();
  let firstConflict: FeasibilityCommit | null = null;
  let cleanCommitCount = upstreamCommits.length;

  for (const [index, commit] of upstreamCommits.entries()) {
    const current = new Set(mergeTree(sourceSha, commit.sha).conflicts);
    if (firstConflict === null && current.size > 0) {
      firstConflict = commit;
      cleanCommitCount = index;
    }
    const filesAdded = [...current].filter((path) => !previousConflicts.has(path)).toSorted();
    const filesRemoved = [...previousConflicts].some((path) => !current.has(path));
    if (filesAdded.length > 0 || filesRemoved) changes.push({ ...commit, filesAdded });
    previousConflicts = current;
  }

  const finalMerge = mergeTree(sourceSha, targetSha);
  const forkCommits = readForkStack(git, sourceSha);
  const attribution = new Map<string, ForkStackCommit>();
  let priorForkConflicts = new Set<string>();
  if (forkCommits.length > 0) {
    const parent = git.run(["rev-parse", `${forkCommits[0]?.sha}^`]).trim();
    priorForkConflicts = new Set(mergeTree(parent, targetSha).conflicts);
  }
  for (const commit of forkCommits) {
    const current = new Set(mergeTree(commit.sha, targetSha).conflicts);
    for (const path of current) {
      if (!priorForkConflicts.has(path)) attribution.set(path, commit);
    }
    for (const path of priorForkConflicts) {
      if (!current.has(path)) attribution.delete(path);
    }
    priorForkConflicts = current;
  }

  const conflicts = finalMerge.conflicts.map((path): FeasibilityConflict => {
    const introducing = attribution.get(path);
    if (introducing === undefined) {
      throw new Error(`could not attribute merge conflict to a fork commit: ${path}`);
    }
    const mergedContents = git.run(["show", `${finalMerge.tree}:${path}`]);
    return {
      path,
      hunkCount: markerCount(mergedContents),
      introducingForkCommit: {
        sha: introducing.sha,
        shortSha: introducing.sha.slice(0, 7),
        subject: introducing.subject,
        domain: introducing.domain,
        tier: introducing.tier,
      },
    };
  });

  const upstreamChanged = readChangedPaths(git, baseSha, targetSha);
  const forkChanged = readChangedPaths(git, baseSha, sourceSha);
  const forkPaths = new Set(forkChanged);
  const overlap = upstreamChanged.filter((path) => forkPaths.has(path));
  const hardConflicts = new Set(finalMerge.conflicts);
  const automerged = overlap.filter((path) => !hardConflicts.has(path));

  return {
    ffBoundary: {
      upstreamCommitCount: upstreamCommits.length,
      cleanCommitCount,
      firstConflict,
      changes,
    },
    conflicts,
    overlap: {
      upstreamChanged: upstreamChanged.length,
      forkChanged: forkChanged.length,
      overlap: overlap.length,
      hardConflict: finalMerge.conflicts.length,
      automerged,
    },
  };
};
