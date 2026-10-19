// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// Hook guard (a fork:scan stage): for a fork commit touching an
// upstream-owned file, added lines must sit inside a marked hook. Marked
// insertions only — cause (a) of the old four-cause hook-seam rule
// (RSI-Software/t3code-hyprws#1190). Removal, marker-declaration, and
// one-construct checks do not come back.

import {
  FORK_HOOK_BLOCK_SUFFIX,
  FORK_HOOK_JSX_END,
  FORK_HOOK_JSX_OPEN,
  FORK_HOOK_LINE_SUFFIX,
  parseForkHookMarkers,
} from "./fork-hooks.ts";

/** Generated dependency and codegen state no fork domain owns by hand. */
export const GENERATED_HOOK_PATH = /(?:^|\/)pnpm-lock\.yaml$|\.gen\.ts$/;

/**
 * The grammars in which a marker form is a comment. JSON has no comment at
 * all, and `//` in Markdown or YAML is body text, so on those paths the
 * remedy the warning names cannot be written and the rule stays silent.
 */
export const MARKER_CAPABLE_PATH = /\.(?:[cm]?[jt]sx?|css|scss)$/;

export interface HookGuardCommit {
  readonly short: string;
  readonly domain: string;
  readonly tier?: string;
  readonly upstreamable?: string;
}

export interface HookGuardChange {
  readonly added: ReadonlyArray<string>;
  // Each added line's 1-based line in the committed file, parallel to `added`.
  readonly addedAt?: ReadonlyArray<number> | undefined;
}

export interface HookGuardInput {
  readonly commit: HookGuardCommit;
  readonly files: ReadonlyArray<string>;
  readonly changedLines: ReadonlyMap<string, HookGuardChange>;
  readonly upstreamFiles: ReadonlySet<string>;
  // The significant lines each touched upstream file carries in the target
  // tree (RSI-Software/t3code-hyprws#1207). An added line the target already
  // has is a revert, not a fork insertion, so it is dropped before the
  // unmarked/code filtering. An absent entry refuses every addition, because
  // an unread tree is not evidence the line was upstream's.
  readonly upstreamLines?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  // Added lines from this commit's unique same-subject pre-replay counterpart,
  // keyed by path. Occurrences matching after trimming are historical
  // insertions, not lines introduced by this replay, and are exempt count by
  // count.
  readonly replayAddedLines?: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
  // The commit's own text of a path. A commit that edits one line of an
  // existing multi-line hook adds no marker, so its added lines alone cannot
  // show the hook; the committed file's markers can.
  readonly readCommittedText?: ((path: string) => string | undefined) | undefined;
}

/** The 1-based lines a marked hook covers in `text`. */
const markedLines = (text: string): ReadonlySet<number> => {
  const marked = new Set<number>();
  for (const hook of parseForkHookMarkers(text))
    for (let n = hook.startLine; n <= hook.endLine; n += 1) marked.add(n);
  return marked;
};

/** A trimmed line that is only comment: `//`, a block opener, or a block continuation. */
const COMMENT_LINE = /^(?:\/\/|\/\*|\*)/;

const isForkHookSuffixLine = (line: string): boolean =>
  FORK_HOOK_LINE_SUFFIX.test(line) || FORK_HOOK_BLOCK_SUFFIX.test(line);

/**
 * A `<>` or `</>` added only to give a marker pair a JSX parent. A JSX
 * comment needs one, so those two lines fall outside the region they exist
 * to open. Adjacency is measured in the added lines.
 */
const isFragmentScaffold = (added: ReadonlyArray<string>, index: number): boolean => {
  const line = added[index]?.trim();
  if (line === "<>") return FORK_HOOK_JSX_OPEN.test(added[index + 1] ?? "");
  if (line === "</>") return FORK_HOOK_JSX_END.test(added[index - 1] ?? "");
  return false;
};

export const hookGuardWarnings = (input: HookGuardInput): ReadonlyArray<string> => {
  // The exemption needs both trailers: an upstreamable bugfix, not one alone.
  if (input.commit.tier === "bugfix" && input.commit.upstreamable === "yes") return [];
  const details: Array<string> = [];
  for (const path of [...input.files].toSorted()) {
    if (!input.upstreamFiles.has(path)) continue;
    if (GENERATED_HOOK_PATH.test(path)) continue;
    if (!MARKER_CAPABLE_PATH.test(path)) continue;
    const change = input.changedLines.get(path);
    if (change === undefined || change.added.length === 0) continue;
    // No formatter exemption: any unmarked edit in range is refused, full
    // stop. Over-refusing is safe — a human marks the line — while
    // under-refusing ships the unmarked edit this gate exists to catch.

    const unmarked: Array<{ readonly line: string; readonly index: number }> = [];
    // The mirror of the upstream-test filter (RSI-Software/t3code-hyprws#1207):
    // that rule drops lines the fork authored, this one drops added lines
    // the upstream target already has.
    const upstream = input.upstreamLines?.get(path);
    // Replay lines match trimmed: an upstream restructure that re-indents a
    // fork line around it leaves the same insertion, not a new one.
    const replayCounts = new Map<string, number>();
    for (const line of input.replayAddedLines?.get(path) ?? []) {
      const key = line.trim();
      replayCounts.set(key, (replayCounts.get(key) ?? 0) + 1);
    }
    for (const [index, line] of change.added.entries()) {
      const replayCount = replayCounts.get(line.trim()) ?? 0;
      if (replayCount > 0) {
        replayCounts.set(line.trim(), replayCount - 1);
        continue;
      }
      if (upstream !== undefined && upstream.has(line.trim())) continue;
      if (line.includes("fork-hook:")) continue;
      if (isFragmentScaffold(change.added, index)) continue;
      unmarked.push({ line, index });
    }
    let code = unmarked.filter(
      ({ line }) => !isForkHookSuffixLine(line) && line.trim() !== "" && /[A-Za-z_$]/.test(line),
    );
    if (code.length > 0) {
      // The committed blob is authoritative: added lines alone miss a marker on an unchanged
      // line, and an edited JSX opener whose end marker is unchanged spans every later hunk.
      const committed = change.addedAt === undefined ? undefined : input.readCommittedText?.(path);
      const covered = markedLines(committed ?? change.added.join("\n"));
      code = code.filter(
        ({ index }) =>
          !covered.has(committed === undefined ? index + 1 : (change.addedAt?.[index] ?? 0)),
      );
    }
    if (code.length === 0) continue;
    const sample = code.slice(0, 3).map(({ line }) => line.trim());
    // A comment-only line ends a trailing marker's backward walk, so marking
    // more cannot cover it; only moving or dropping the comment can.
    const remedy = code.every(({ line }) => COMMENT_LINE.test(line.trim()))
      ? "a comment-only line stops the marker's walk, so move the comment inside the statement or drop it"
      : "mark a complete added statement whose opening context is also added; in a sync, adapt in a tip `fixup!` of the owner, never inside a replayed commit";
    details.push(
      `${path}: ${code.length} added line(s) outside a marked hook (first: ${sample.join(" / ")}); ${remedy}`,
    );
  }
  return details;
};
