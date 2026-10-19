// The re-apply stage the sync walk runs on every unmerged path rerere left: marked hook lines are
// re-inserted from the manifest instead of handing the seam to a human. A hook re-applies only when
// its context anchor resolves to exactly one merged-upstream site and its marked line is readable
// from the fork side; anything else refuses (a dead hook that typechecks is worse than a stop).

import {
  FORK_HOOK_BLOCK_SUFFIX,
  FORK_HOOK_JSX_END,
  FORK_HOOK_JSX_OPEN,
  FORK_HOOK_LINE_SUFFIX,
  parseForkHookMarkers,
  type ForkHookAnchor,
  type ParsedForkHook,
} from "./fork-hooks.ts";

/** The outcome the re-apply stage reaches for one manifest hook. */
export type ForkHookReapply =
  | { readonly status: "intact" }
  | {
      readonly status: "reinsert";
      /** The marked line(s) from the fork side, shifted only when upstream re-indented the anchor. */
      readonly lines: ReadonlyArray<string>;
      /** Insert the lines before this 0-based line index of the merged text. */
      readonly at: number;
    }
  | { readonly status: "refuse"; readonly reason: string };

/** Read one hook's exact marked text out of the fork side; `null` when the marker is unreadable.
 * An overlaid tip span (RSI-Software/t3code-hyprws#1030) points at raw lines that carry no marker
 * in this commit, so the marker-syntax assertion is skipped — the raw lines are what re-inserts. */
const forkHookLines = (fork: string, hook: ParsedForkHook): ReadonlyArray<string> | null => {
  const lines = fork.split("\n");
  const slice = lines.slice(hook.startLine - 1, hook.endLine);
  if (slice.length !== hook.endLine - hook.startLine + 1) return null;
  if (hook.overlay === true) return slice;
  const body = slice.join("\n");
  const suffixed = FORK_HOOK_LINE_SUFFIX.test(body) || FORK_HOOK_BLOCK_SUFFIX.test(body);
  if (hook.kind === "line" ? !suffixed : !FORK_HOOK_JSX_OPEN.test(body)) return null;
  if (hook.kind === "jsx" && !FORK_HOOK_JSX_END.test(slice[slice.length - 1] ?? "")) return null;
  return slice;
};

/**
 * The 0-based line the hook's context anchor ends on in `lines`, or the ambiguity that refuses.
 * An empty context is the top of the file. The exact-text match is tried first and a trimmed
 * match only as a fallback, so an upstream re-indent still places the hook while an exact tree
 * never depends on whitespace luck.
 */
const anchorEnd = (
  lines: ReadonlyArray<string>,
  context: ReadonlyArray<string>,
): { readonly at: number; readonly exact: boolean } | { readonly sites: number } => {
  if (context.length === 0) return { at: -1, exact: true };
  for (const [index, shape] of [(line: string) => line, (line: string) => line.trim()].entries()) {
    const wanted = context.map(shape);
    const hits: Array<number> = [];
    for (let start = 0; start + context.length <= lines.length; start += 1) {
      let matched = true;
      for (const [offset, text] of wanted.entries())
        if (shape(lines[start + offset] ?? "") !== text) {
          matched = false;
          break;
        }
      if (matched) hits.push(start + context.length - 1);
    }
    if (hits.length === 1) return { at: hits[0] ?? 0, exact: index === 0 };
    if (hits.length > 1) return { sites: hits.length };
  }
  return { sites: 0 };
};

const indentWidth = (line: string): number => line.length - line.trimStart().length;

/**
 * The columns upstream shifted the anchor by: its last non-blank context line in the fork text
 * against the same line in the merged text, which ends at `at`.
 */
const anchorShift = (
  lines: ReadonlyArray<string>,
  context: ReadonlyArray<string>,
  at: number,
): number => {
  for (let offset = context.length - 1; offset >= 0; offset -= 1) {
    const forkLine = context[offset] ?? "";
    if (forkLine.trim() === "") continue;
    return indentWidth(lines[at - (context.length - 1 - offset)] ?? "") - indentWidth(forkLine);
  }
  return 0;
};

/**
 * Whether a later hook line may start inside a string, where indent is content. Any backtick or
 * line continuation counts: telling a quoted backtick from a template needs a tokenizer, and a
 * hook left verbatim only costs a format fix.
 */
const mayContinueLiteral = (lines: ReadonlyArray<string>): boolean =>
  lines.length > 1 && lines.some((line) => line.includes("`") || line.endsWith("\\"));

const shiftIndent = (lines: ReadonlyArray<string>, shift: number): ReadonlyArray<string> =>
  shift === 0 || mayContinueLiteral(lines)
    ? lines
    : lines.map((line) => {
        if (line.trim() === "") return line;
        if (shift > 0) return " ".repeat(shift) + line;
        return line.slice(Math.min(-shift, indentWidth(line)));
      });

/**
 * Resolve one hook against the merged upstream text: intact when its marker survived, else its own
 * lines re-inserted after its context anchor. Lines shift indent only when the anchor matched by
 * trimmed text (upstream re-indented); a hook that may span a string literal stays verbatim.
 */
const resolveHook = (
  merged: string,
  fork: string,
  hook: ParsedForkHook | undefined,
  anchor: ForkHookAnchor,
): ForkHookReapply => {
  const lines = merged.split("\n");
  if (hook !== undefined && parseForkHookMarkers(merged).some((marked) => marked.key === hook.key))
    return { status: "intact" };
  if (hook === undefined)
    return {
      status: "refuse",
      reason: "the fork side of this conflict carries no readable marker for the hook",
    };
  const marked = forkHookLines(fork, hook);
  if (marked === null)
    return { status: "refuse", reason: "the hook's marked line is unreadable in the fork text" };
  const found = anchorEnd(lines, anchor.context);
  if ("sites" in found)
    return {
      status: "refuse",
      reason:
        found.sites === 0
          ? "the hook's anchor context is not in the merged text"
          : `the hook's anchor context matches ${found.sites} sites; the anchor is ambiguous`,
    };
  const shift = found.exact ? 0 : anchorShift(lines, anchor.context, found.at);
  return { status: "reinsert", lines: shiftIndent(marked, shift), at: found.at + 1 };
};

/** Insert every reinsertion into the merged text without touching any existing line. */
const applyForkHookReinserts = (
  merged: string,
  inserts: ReadonlyArray<{ readonly at: number; readonly lines: ReadonlyArray<string> }>,
): string => {
  const lines = merged.split("\n");
  // Later indices first so earlier indices stay valid; equal indices end up in hook order.
  const ordered = inserts.map((insert, order) => ({ ...insert, order }));
  ordered.sort((left, right) =>
    left.at !== right.at ? right.at - left.at : right.order - left.order,
  );
  for (const insert of ordered) lines.splice(insert.at, 0, ...insert.lines);
  return lines.join("\n");
};

export interface ForkHookReapplyResult {
  /** Per manifest hook, in the order given. */
  readonly results: ReadonlyArray<{ readonly key: string; readonly outcome: ForkHookReapply }>;
  /** The merged text with every reinsertion applied (unchanged when nothing was re-inserted). */
  readonly text: string;
  /** The keys whose hook line the stage re-inserted. */
  readonly reinserted: ReadonlyArray<string>;
}

/**
 * Re-apply the marked hooks one conflicted path carries. `merged` is the upstream-resolved text and
 * `fork` the fork-side text hook lines are read from. A key with no in-file marker reads its lines
 * from its tip-located span in `resolved`: raw lines of `fork`, so no new marker enters the text.
 */
export const reapplyForkHooks = (
  merged: string,
  fork: string,
  entries: ReadonlyArray<{
    readonly key: string;
    readonly anchor: ForkHookAnchor;
    /** The tip's span for this entry, when the caller derived it from another tree. */
    readonly span?: ParsedForkHook;
  }>,
  resolved?: { readonly spans: ReadonlyMap<string, ParsedForkHook> },
): ForkHookReapplyResult => {
  const markers = new Map(parseForkHookMarkers(fork).map((hook) => [hook.key, hook]));
  for (const [key, span] of resolved?.spans ?? []) if (!markers.has(key)) markers.set(key, span);
  const results = entries.map(({ key, anchor, span }) => ({
    key,
    outcome: resolveHook(merged, fork, span ?? markers.get(key), anchor),
  }));
  const inserts = results.flatMap(({ outcome }) =>
    outcome.status === "reinsert" ? [{ at: outcome.at, lines: outcome.lines }] : [],
  );
  return {
    results,
    text: applyForkHookReinserts(merged, inserts),
    reinserted: results
      .filter(({ outcome }) => outcome.status === "reinsert")
      .map(({ key }) => key),
  };
};
