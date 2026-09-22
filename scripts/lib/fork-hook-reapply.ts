// The re-apply stage the sync walk runs after keep-both declines (RSI-Software/t3code-hyprws#953):
// Gate: sync tip — re-inserts fully marked hooks during the sync rebase; anything else refuses and stops the run.
// when upstream rewrote a file a fork commit also touched, the marked hook lines are re-inserted
// from the manifest instead of handing the seam to a human.
//
// The rule is deliberately narrow. A hook is re-applied only when its derived context anchor
// (RSI-Software/t3code-hyprws#1155) resolves to exactly one site in the merged upstream text, and
// the hook's exact marked line (or JSX pair) is still readable from the fork side. Zero sites,
// several sites, or an unreadable hook line are all a refusal — a dead hook that typechecks is
// worse than a stop, so there is deliberately no file-end fallback. Re-insertion only ever
// inserts: an upstream line is never deleted or rewritten to make room for a hook.

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
      /** The exact marked line(s) from the fork side, verbatim. */
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
): { readonly at: number } | { readonly sites: number } => {
  if (context.length === 0) return { at: -1 };
  for (const shape of [(line: string) => line, (line: string) => line.trim()]) {
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
    if (hits.length === 1) return { at: hits[0] ?? 0 };
    if (hits.length > 1) return { sites: hits.length };
  }
  return { sites: 0 };
};

/**
 * Resolve one derived hook against the merged upstream text: intact when the marker survived,
 * otherwise the hook's own lines re-inserted verbatim directly after its context anchor. The
 * lines are never re-indented — they are the fork tip's own bytes, and the anchor places them in
 * the same neighbourhood they were written in.
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
  return { status: "reinsert", lines: marked, at: found.at + 1 };
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
 * Re-apply the marked hooks one conflicted path carries in the manifest. `merged` is the merged
 * upstream text (conflict hunks already resolved to the upstream side); `fork` is the fork-side
 * text the hook's exact marked line is read from; `entries` are the derived rows for the path.
 * `resolved` carries the fork tip's declaration spans (RSI-Software/t3code-hyprws#1030): a key
 * with no in-file marker in `fork` reads its lines from the tip-located span — the raw, unmarked
 * lines of `fork` itself, never an annotated copy, so the resolved text carries no marker the
 * fork blob did not already have.
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
