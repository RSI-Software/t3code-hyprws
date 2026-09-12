// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type CwdCommandRunner as CommandRunner } from "./fork-command.ts";
import { isVerifiablePath } from "./fork-repairs.ts";
import * as NodeCrypto from "node:crypto";

/**
 * The machine half of an unattended walk: it decides one conflicted path the way the fork's
 * doctrine decides it, or it declines. Declining is the walk's only conflict stop, so every rule
 * here has to be one a maintainer would have applied by hand for the same reason.
 *
 * During a rebase the index stages are upstream-shaped, not branch-shaped: stage 1 is the merge
 * base, stage 2 ("ours") is the upstream target the stack replays onto, and stage 3 ("theirs") is
 * the fork commit being replayed. Every rule below is written in those terms.
 *
 * There is deliberately no "upstream superseded this commit" rule. Gate 4 keeps every candidate,
 * so a commit upstream appears to carry is still replayed; taking the upstream side of its files
 * would keep the commit and gut its content, which is the one outcome the fork forbids. Retiring a
 * fork commit stays a human decision in `docs/internals/fork-delta.md`.
 */
export type OutcomeSource = "upstream-only" | "fork-only" | "keep-both";

export type OutcomeTake = "ours" | "theirs" | "merge" | "union";

export interface ConflictOutcome {
  readonly take: OutcomeTake;
  /** The conflict class the record row carries, in the ledger's existing vocabulary. */
  readonly conflictClass: "mechanical" | "seam-moved";
  readonly source: OutcomeSource;
  readonly resolution: string;
}

export interface ConflictStages {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

/**
 * Fork doctrine, in the order a maintainer applies it:
 *
 * 1. only upstream moved, so upstream's text stands;
 * 2. only the fork moved, so the fork feature keeps working;
 * 3. both moved, so keep both — the fork is additive, and an upstream feature is never removed to
 *    make a fork approach fit. Whether keeping both is achievable is decided during execution,
 *    because it depends on whether the two sides rewrote the same lines.
 */
export const classifyConflictOutcome = (stages: ConflictStages): ConflictOutcome => {
  if (stages.theirs === stages.base)
    return {
      take: "ours",
      conflictClass: "mechanical",
      source: "upstream-only",
      resolution: "outcome executor: only upstream moved",
    };
  if (stages.ours === stages.base)
    return {
      take: "theirs",
      conflictClass: "mechanical",
      source: "fork-only",
      resolution: "outcome executor: only the fork moved",
    };
  return {
    take: "union",
    conflictClass: "seam-moved",
    source: "keep-both",
    resolution: "outcome executor: keep both (consider keeping ours)",
  };
};

const CONFLICT_MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m;

const significantLineCounts = (text: string): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
};

/**
 * The fork is additive: a resolution may drop a fork line, and may drop a line upstream itself
 * removed, but it may never drop a line upstream added at this seam. Cheap enough to run on every
 * resolution, and it is what turns "keep both" from a hope into a checked property.
 */
export const preservesUpstreamAdditions = (
  base: string,
  ours: string,
  resolved: string,
): boolean => {
  const baseCounts = significantLineCounts(base);
  const resolvedCounts = significantLineCounts(resolved);
  for (const [line, count] of significantLineCounts(ours)) {
    const added = count - (baseCounts.get(line) ?? 0);
    if (added <= 0) continue;
    if ((resolvedCounts.get(line) ?? 0) < added) return false;
  }
  return true;
};

/**
 * Every conflicted hunk in a `--diff3` merge is a pure co-insertion: both sides added text where
 * the base had nothing. Keeping both sides of that is addition. Keeping both sides of a hunk whose
 * base region has content is not: the two sides rewrote the same lines, and a union of two rewrites
 * is a file that says the old thing and the new thing at once. That case is a maintainer's.
 */
export const everyConflictIsCoInsertion = (diff3: string): boolean => {
  let inBase = false;
  let baseHasContent = false;
  for (const line of diff3.split("\n")) {
    if (line.startsWith("|||||||")) {
      inBase = true;
      continue;
    }
    if (line.startsWith("=======") || line.startsWith(">>>>>>>") || line.startsWith("<<<<<<<")) {
      inBase = false;
      continue;
    }
    if (inBase && line.trim().length > 0) baseHasContent = true;
  }
  return !baseHasContent;
};

export interface ExecutedOutcome extends ConflictOutcome {
  readonly path: string;
}

export interface UnresolvedOutcome {
  readonly path: string;
  readonly reason: string;
}

export type OutcomeResult = ExecutedOutcome | UnresolvedOutcome;

export const isUnresolved = (result: OutcomeResult): result is UnresolvedOutcome =>
  "reason" in result;

interface ConflictRegion {
  readonly label: string | null;
  readonly text: ReadonlyArray<string>;
}

interface Diff3ConflictRegion {
  readonly upstream: string;
  readonly base: string;
  readonly fork: string;
}

/**
 * Split the `<<<<<<<`..`>>>>>>>` hunk regions out of a diff3 merge, without the marker lines.
 * Labels in the merged text separate the stages; when they are absent the region is kept without
 * one rather than guessed.
 */
const conflictRegions = (diff3: string): ReadonlyArray<ConflictRegion> => {
  const regions: Array<ConflictRegion> = [];
  let current: { label: string | null; text: Array<string> } | null = null;
  for (const line of diff3.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      current = { label: line.slice(7).trim() || null, text: [] };
      continue;
    }
    if (current !== null && line.startsWith(">>>>>>>")) {
      regions.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.text.push(line);
  }
  return regions;
};

/** Read diff3 hunks without normalising their contents: the unchanged-side proof is byte-exact. */
const diff3ConflictRegions = (diff3: string): ReadonlyArray<Diff3ConflictRegion> | null => {
  const regions: Array<Diff3ConflictRegion> = [];
  let current: {
    upstream: Array<string>;
    base: Array<string>;
    fork: Array<string>;
    part: "upstream" | "base" | "fork";
  } | null = null;
  for (const line of diff3.split(/(?<=\n)/)) {
    if (line.startsWith("<<<<<<<")) {
      if (current !== null) return null;
      current = { upstream: [], base: [], fork: [], part: "upstream" };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("|||||||")) {
      if (current.part !== "upstream") return null;
      current.part = "base";
      continue;
    }
    if (line.startsWith("=======")) {
      if (current.part !== "base") return null;
      current.part = "fork";
      continue;
    }
    if (line.startsWith(">>>>>>>")) {
      if (current.part !== "fork") return null;
      regions.push({
        upstream: current.upstream.join(""),
        base: current.base.join(""),
        fork: current.fork.join(""),
      });
      current = null;
      continue;
    }
    current[current.part].push(line);
  }
  return current === null ? regions : null;
};

/** CRLF and per-line trailing whitespace do not move a seam; they should not move its key. */
const canonicalRegion = (region: ConflictRegion): unknown => ({
  label: region.label,
  text: region.text.map((line) => line.replace(/\r$/, "").replace(/\s+$/, "")),
});

/**
 * A stable content key for one conflicted seam: the sha256 of its path and its diff3 conflict
 * hunks. Moving the seam up or down the file, retagging the walk, or re-running git's diff
 * algorithm leaves the key alone, so a resolution recorded under one tag still names the same
 * seam on the next. `null` when the merge has no conflict hunks — a conflict-free merge has no
 * seam to name.
 */
export const seamKey = (
  runner: CommandRunner,
  worktree: string,
  seam: {
    readonly path: string;
    readonly base: string;
    readonly ours: string;
    readonly theirs: string;
  },
): string | null => {
  const merged = mergeFile(runner, worktree, seam, "--diff3");
  if (merged === null) return null;
  const regions = conflictRegions(merged.text);
  if (regions.length === 0) return null;
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ path: seam.path, hunks: regions.map(canonicalRegion) }))
    .digest("hex");
};

const readStage = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  stage: 1 | 2 | 3,
): string | null => {
  const result = runner.run("git", ["show", `:${stage}:${path}`], worktree);
  if (result.status !== 0 || result.error !== undefined) return null;
  return result.stdout;
};

/** Read the three index stages of a conflicted path; `null` once the conflict is staged away. */
export const readConflictStages = (
  runner: CommandRunner,
  worktree: string,
  path: string,
): ConflictStages | null => {
  const base = readStage(runner, worktree, path, 1);
  const ours = readStage(runner, worktree, path, 2);
  const theirs = readStage(runner, worktree, path, 3);
  return base === null || ours === null || theirs === null ? null : { base, ours, theirs };
};

const isText = (value: string): boolean => !value.includes("\0");

interface MergeResult {
  readonly text: string;
  readonly conflicts: number;
}

/**
 * git owns the three-way merge; a hand-rolled one would only be a second, worse implementation of
 * the same walk. `git merge-file` takes no `--diff-algorithm`, so the hunk split is whatever git's
 * default gives. Its exit status is the number of conflicts, and negative (255 in practice) on a
 * real error.
 */
const mergeFile = (
  runner: CommandRunner,
  worktree: string,
  stages: ConflictStages,
  style: "--diff3" | "--union",
): MergeResult | null => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-outcome-"));
  try {
    const files = { base: "base", ours: "ours", theirs: "theirs" } as const;
    for (const side of ["base", "ours", "theirs"] as const)
      NodeFS.writeFileSync(NodePath.join(directory, files[side]), stages[side]);
    const merged = runner.run(
      "git",
      [
        "merge-file",
        style,
        "-p",
        "-L",
        "upstream",
        "-L",
        "base",
        "-L",
        "fork",
        NodePath.join(directory, files.ours),
        NodePath.join(directory, files.base),
        NodePath.join(directory, files.theirs),
      ],
      worktree,
    );
    if (merged.error !== undefined || merged.status < 0 || merged.status > 127) return null;
    return { text: merged.stdout, conflicts: merged.status };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * Keep both sides of a seam both sides moved, when that is addition rather than invention. A clean
 * three-way merge is taken as it stands. A conflicted one is kept only when every hunk is a pure
 * co-insertion, and only on a path the lane can verify afterwards.
 */
/**
 * A moved neighbour can make Git put an otherwise untouched deletion into a rewrite conflict.
 * Select the deleting side only when every base hunk it removes occurs exactly once, byte-for-byte,
 * in the other side. Replacing that occurrence retains the other side's moved neighbours and any
 * additions around it; duplicate occurrences are deliberately a judgement rather than a guess.
 */
/** Replace the one byte-exact base hunk without interpreting `$` sequences in the replacement. */
const replaceBaseHunk = (text: string, base: string, replacement: string): string => {
  const index = text.indexOf(base);
  return text.slice(0, index) + replacement + text.slice(index + base.length);
};

const movedDeletion = (
  runner: CommandRunner,
  worktree: string,
  stages: ConflictStages,
): { readonly text: string; readonly outcome: ConflictOutcome } | null => {
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null || merged.conflicts === 0) return null;
  const regions = diff3ConflictRegions(merged.text);
  if (regions === null || regions.length === 0) return null;
  const directions = regions.map(({ base, upstream, fork }) => {
    if (base.length === 0) return null;
    const upstreamOccurrences = upstream.split(base).length - 1;
    const forkOccurrences = fork.split(base).length - 1;
    // The deleting side must remove at least one byte of this exact base hunk. An insertion that
    // leaves the whole base hunk present belongs to the ordinary keep-both rule instead.
    if (forkOccurrences === 0 && upstreamOccurrences === 1) return "fork" as const;
    if (upstreamOccurrences === 0 && forkOccurrences === 1) return "upstream" as const;
    return null;
  });
  const direction = directions[0];
  if (direction === null || directions.some((value) => value !== direction)) return null;
  let position = 0;
  let resolved = "";
  for (const region of regions) {
    const start = merged.text.indexOf("<<<<<<<", position);
    const end = merged.text.indexOf(">>>>>>>", start);
    if (start === -1 || end === -1) return null;
    const lineEnd = merged.text.indexOf("\n", end);
    const replacement =
      direction === "fork"
        ? replaceBaseHunk(region.upstream, region.base, region.fork)
        : replaceBaseHunk(region.fork, region.base, region.upstream);
    resolved += merged.text.slice(position, start) + replacement;
    position = lineEnd === -1 ? merged.text.length : lineEnd + 1;
  }
  resolved += merged.text.slice(position);
  return direction === "fork"
    ? {
        text: resolved,
        outcome: {
          take: "theirs",
          conflictClass: "mechanical",
          source: "fork-only",
          resolution:
            "outcome executor: moved-deletion (fork deletion over byte-identical upstream base)",
        },
      }
    : {
        text: resolved,
        outcome: {
          take: "ours",
          conflictClass: "mechanical",
          source: "upstream-only",
          resolution:
            "outcome executor: moved-deletion (upstream deletion over byte-identical fork base)",
        },
      };
};

/** Match delimiters locally; uncertain syntax is a declined conflict, not a guessed resolution. */
const matchingDelimiter = (
  text: string,
  start: number,
  open: string,
  close: string,
): number | null => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let comment: "line" | "block" | null = null;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (comment === "line") {
      if (character === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (character === "*" && text[index + 1] === "/") {
        comment = null;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      comment = "line";
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      comment = "block";
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "`") return null;
    if (character === open) depth += 1;
    if (character === close && --depth === 0) return index;
  }
  return null;
};

const dependencyEntries = (
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: string }> | null => {
  const lines = text.split(/(?<=\n)/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const entries = lines.map((line) => {
    const match = /^(\s*)([A-Za-z_$][\w$]*),?\s*(?:\r?\n)?$/.exec(line);
    return match === null ? null : { name: match[2], line };
  });
  return entries.some((entry) => entry === null)
    ? null
    : (entries as ReadonlyArray<{ name: string; line: string }>);
};

const hookForDependencyRegion = (
  text: string,
  regionStart: number,
): { readonly body: string } | null => {
  const hooks = /\b(?:useCallback|useMemo|useEffect)\s*\(/g;
  const candidates: Array<{ body: string }> = [];
  for (let match = hooks.exec(text); match !== null; match = hooks.exec(text)) {
    const callEnd = matchingDelimiter(text, match.index + match[0].length - 1, "(", ")");
    if (callEnd === null) continue;
    const arrow = text.indexOf("=>", match.index + match[0].length);
    if (arrow === -1 || arrow > callEnd) continue;
    const bodyStart = text.indexOf("{", arrow + 2);
    if (bodyStart === -1 || bodyStart > callEnd) continue;
    const bodyEnd = matchingDelimiter(text, bodyStart, "{", "}");
    if (bodyEnd === null) continue;
    const comma = text.slice(bodyEnd + 1).match(/^\s*,\s*/);
    if (comma === null) continue;
    const dependenciesStart = bodyEnd + 1 + comma[0].length;
    if (text[dependenciesStart] !== "[") continue;
    const dependenciesEnd = matchingDelimiter(text, dependenciesStart, "[", "]");
    if (dependenciesEnd === null) continue;
    if (dependenciesStart < regionStart && regionStart < dependenciesEnd)
      candidates.push({ body: text.slice(bodyStart + 1, bodyEnd) });
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
};

const referencedDependencyNames = (
  body: string,
  entries: ReadonlySet<string>,
): ReadonlySet<string> | null => {
  // Templates can interpolate an identifier; unlike quoted strings and comments they cannot be
  // removed without parsing, so this local scan declines them.
  if (body.includes("`")) return null;
  const source = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, " ");
  const bound = new Set(
    [...source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1],
    ),
  );
  if ([...entries].some((name) => bound.has(name))) return null;
  const referenced = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    if (!entries.has(name)) continue;
    const before = source.slice(0, match.index).trimEnd();
    const after = source.slice((match.index ?? 0) + name.length).trimStart();
    if (before.endsWith(".")) continue;
    if (after.startsWith(":")) return null;
    referenced.add(name);
  }
  return referenced;
};

const dependencyArray = (
  runner: CommandRunner,
  worktree: string,
  stages: ConflictStages,
): { readonly text: string; readonly outcome: ConflictOutcome } | null => {
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null || merged.conflicts === 0) return null;
  const regions = diff3ConflictRegions(merged.text);
  if (regions === null || regions.length === 0) return null;
  let position = 0;
  let resolved = "";
  for (const region of regions) {
    const start = merged.text.indexOf("<<<<<<<", position);
    const end = merged.text.indexOf(">>>>>>>", start);
    if (start === -1 || end === -1) return null;
    const hook = hookForDependencyRegion(merged.text, start);
    const ours = dependencyEntries(region.upstream);
    const theirs = dependencyEntries(region.fork);
    if (hook === null || ours === null || theirs === null) return null;
    const entries = [...ours, ...theirs];
    const names = new Set(entries.map(({ name }) => name));
    const referenced = referencedDependencyNames(hook.body, names);
    if (referenced === null) return null;
    const replacement = entries
      .filter(
        ({ name }, index) =>
          referenced.has(name) && entries.findIndex((entry) => entry.name === name) === index,
      )
      .map(({ line }) => line)
      .join("");
    if (replacement === "") return null;
    const lineEnd = merged.text.indexOf("\n", end);
    resolved += merged.text.slice(position, start) + replacement;
    position = lineEnd === -1 ? merged.text.length : lineEnd + 1;
  }
  resolved += merged.text.slice(position);
  return {
    text: resolved,
    outcome: {
      take: "union",
      conflictClass: "mechanical",
      source: "keep-both",
      resolution: "outcome executor: dependency-array union kept referenced hook dependencies",
    },
  };
};

const keepBoth = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  stages: ConflictStages,
): { readonly text: string; readonly outcome: ConflictOutcome } | UnresolvedOutcome => {
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null) return { path, reason: "git merge-file could not merge this seam" };
  if (merged.conflicts === 0 && !CONFLICT_MARKER.test(merged.text))
    return {
      text: merged.text,
      outcome: {
        take: "merge",
        conflictClass: "seam-moved",
        source: "keep-both",
        resolution: "outcome executor: three-way merge kept both sides",
      },
    };
  if (!everyConflictIsCoInsertion(merged.text))
    return {
      path,
      reason:
        "upstream and the fork rewrote the same lines; keeping both would say two things at once, so a maintainer owns this seam",
    };
  if (!isVerifiablePath(path))
    return {
      path,
      reason:
        "both sides changed a path the lane cannot typecheck or test, so a kept-both resolution would carry no verification",
    };
  const union = mergeFile(runner, worktree, stages, "--union");
  if (union === null) return { path, reason: "git merge-file could not produce a union merge" };
  return {
    text: union.text,
    outcome: {
      take: "union",
      conflictClass: "seam-moved",
      source: "keep-both",
      resolution: "outcome executor: keep both (co-insertion; consider keeping ours)",
    },
  };
};

/**
 * Resolve one conflicted path in the rehearsal lane and stage it, or say why it cannot be resolved.
 * A declined path is the walk's legal conflict stop; nothing here guesses past a missing stage,
 * a binary blob, a rewritten seam, or a resolution that would drop upstream work.
 */
export const executeConflictOutcome = (
  runner: CommandRunner,
  worktree: string,
  path: string,
): OutcomeResult => {
  const base = readStage(runner, worktree, path, 1);
  const ours = readStage(runner, worktree, path, 2);
  const theirs = readStage(runner, worktree, path, 3);
  if (base === null || ours === null || theirs === null)
    return {
      path,
      reason:
        "conflict has no common ancestor on both sides (add/add, delete/modify, or rename); a maintainer owns this shape",
    };
  if (![base, ours, theirs].every(isText)) return { path, reason: "conflicted file is binary" };
  const stages: ConflictStages = { base, ours, theirs };
  const classified = classifyConflictOutcome(stages);
  let outcome = classified;
  let resolved: string;
  if (classified.take === "ours") resolved = ours;
  else if (classified.take === "theirs") resolved = theirs;
  else {
    const deletion = movedDeletion(runner, worktree, stages);
    if (deletion !== null) {
      resolved = deletion.text;
      outcome = deletion.outcome;
    } else {
      const dependencies = dependencyArray(runner, worktree, stages);
      if (dependencies !== null) {
        resolved = dependencies.text;
        outcome = dependencies.outcome;
      } else {
        const kept = keepBoth(runner, worktree, path, stages);
        if ("reason" in kept) return kept;
        resolved = kept.text;
        outcome = kept.outcome;
      }
    }
  }
  if (CONFLICT_MARKER.test(resolved))
    return { path, reason: "resolution still carries conflict markers" };
  if (!preservesUpstreamAdditions(base, ours, resolved))
    return { path, reason: "resolution would drop a line upstream added at this seam" };
  NodeFS.writeFileSync(NodePath.join(worktree, path), resolved);
  const staged = runner.run("git", ["add", "--", path], worktree);
  if (staged.status !== 0 || staged.error !== undefined)
    return { path, reason: `git add refused the resolution: ${staged.stderr.trim()}` };
  return { ...outcome, path };
};
