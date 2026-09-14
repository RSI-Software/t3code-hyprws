// The `fork-hook-seam` rule, registered in `fork-scan-guards.ts` but kept here:
// that file crossed the 700-line focus limit long ago. The rule is warn-only
// (deliberately outside `ADOPTED_AUTHORING_GUARDS`) until the sweep clears the
// woven-seam stack (RSI-Software/t3code-hyprws#948).
//
// For a fork commit touching an upstream-owned file it warns, one warning per
// file per cause with a line count, on:
//
// (a) added lines outside a marked hook;
// (b) removed or rewritten upstream lines — a hook never deletes upstream code, except that an
//     in-place substitution may remove the upstream line it replaces: the replacing line carries
//     the marker, and the same positional alignment the sync walk runs (`fork-hook-alignment.ts`)
//     decides the removal is declared rather than debt;
// (c) markers with no entry in the `FORK_HOOKS` manifest;
// (d) a marked hook that is more than one construct.
//
// A commit whose trailers are `Fork-Tier: bugfix` **and** `Fork-Upstreamable:
// yes` is exempt: it is an upstream-bound fix, not a fork seam. Generated paths
// (`pnpm-lock.yaml`, `*.gen.ts`) and fork-owned files are outside the rule; both
// reuse the scanner's existing ownership classification, not a second one.
//
// What the one-construct check does not catch: fork logic hidden in nested
// expressions of one allowed element, several fork calls chained in one `const`
// initializer, attribute helpers on an in-scope element, and any shape where
// the added lines are syntactically innocent but their context is not — the
// rule sees only diff lines, not the whole file. A pre-existing hook region is
// likewise invisible to a patch-only view: additions inside one warn as
// unmarked, which over-warns until adoption makes the whole-file read cheap.

import {
  FORK_HOOK_BLOCK_SUFFIX,
  FORK_HOOK_JSX_END,
  FORK_HOOK_JSX_OPEN,
  FORK_HOOK_LINE_SUFFIX,
  HOOK_REEXPORT,
  parseForkHookMarkers,
  stripForkHookLineMarker,
} from "./fork-hooks.ts";
import { unexplainedRemovalLines } from "./fork-hook-alignment.ts";

/** Generated dependency and codegen state no fork domain owns by hand. */
export const GENERATED_HOOK_PATH = /(?:^|\/)pnpm-lock\.yaml$|\.gen\.ts$/;

// A marked line hook must be exactly one of these shapes. The property/spread
// shape additionally names a fork identifier; the others are structural.
// `@import` is the CSS spelling of the same construct; a fork sheet is pulled in that way.
const HOOK_IMPORT = /^\s*(?:@?import\b|export\s+\{[^}]*\}\s*from\b|export\s*\*)/;
const HOOK_SINGLE_CALL =
  /^(?!\s*(?:if|for|while|switch|catch|return)\s*\()\s*[A-Za-z_$][\w$.]*\s*\(/;
// A multi-line branch dispatch carried whole behind a closing-brace marker: the condition names
// the fork, so the whole statement is still one fork construct.
const HOOK_BRANCH = /^\s*(?:if|for|while|switch)\s*\(/;
const HOOK_CONST_FROM_CALL =
  /^\s*(?:export\s+)?const\s+[\w$]+(?:\s*:\s*[^=]+)?\s*=\s*[A-Za-z_$][\w$.]*\s*\(/;
const HOOK_FORK_NAMED = /[Ff]ork|Hypr|hyprws/;
// The spread half covers both spellings of the same construct: an object spread and its JSX
// attribute form, `{...forkProps}`, which is the shape that avoids rewriting upstream prop lines.
const HOOK_PROPERTY =
  /^\s*(?:\{\.\.\.[A-Za-z_$][\w$.]*\}|\.\.\.[A-Za-z_$][\w$.]*|[\w$"']+\s*:\s*[A-Za-z_$][\w$.]*)\s*,?\s*$/;
// Inside a JSX hook only an in-scope element is allowed — no derived rows, no
// statements. These are the shapes that smuggle a second construct in.
const JSX_HOOK_FLOW =
  /\b(?:if|for|while|switch)\s*\(|^\s*(?:const|let|var|function|return)\b|\.\s*(?:map|filter|flatMap|reduce|forEach)\s*\(/;

/** A line closed by a trailing fork-hook marker in either the line-comment or block form. */
const isForkHookSuffixLine = (line: string): boolean =>
  FORK_HOOK_LINE_SUFFIX.test(line) || FORK_HOOK_BLOCK_SUFFIX.test(line);

/**
 * The fork side of the diff, rebuilt so the removal charge can be judged on real positions the
 * way the sync walk judges it: the upstream blob with the diff's removals taken out and its
 * additions put back at their post-image positions. Returns `null` — charge, never exempt —
 * when the shape does not reconstruct: position arrays out of alignment with their lines, one
 * post-image position claimed twice, or an addition whose position the blob cannot reach. The
 * failure direction is strict because a wrong exemption would bless a gutted line.
 */
const forkSideOfDiff = (
  upstream: ReadonlyArray<string>,
  removedAt: ReadonlyArray<number>,
  added: ReadonlyArray<string>,
  addedAt: ReadonlyArray<number>,
): string | null => {
  if (added.length !== addedAt.length) return null;
  const removedSet = new Set(removedAt);
  const addedByPost = new Map<number, string>();
  for (const [index, post] of addedAt.entries()) {
    const line = added[index];
    if (line === undefined || addedByPost.has(post)) return null;
    addedByPost.set(post, line);
  }
  const lines: Array<string> = [];
  let pre = 1;
  let post = 1;
  while (pre <= upstream.length || addedByPost.has(post)) {
    const inserted = addedByPost.get(post);
    if (inserted !== undefined) {
      lines.push(inserted);
      post += 1;
      continue;
    }
    const text = upstream[pre - 1];
    if (text === undefined) return null;
    if (!removedSet.has(pre)) {
      lines.push(text);
      post += 1;
    }
    pre += 1;
  }
  return lines.join("\n");
};

/**
 * The change-block grouping the diff implies, turned into the declared-substitution set: for
 * each maximal run of removals, the additions whose post-image positions fall in the gap it
 * left are the lines that replaced it — git emits a block as its removals followed by its
 * additions, so gap-adjacency is the pairing the patch itself asserts. A removal joins the set
 * only when every addition in its gap is a line-kind marked hook; a gap holding an unmarked
 * line or only a JSX region declares nothing. Malformed positions — one post-image slot
 * claimed twice — declare nothing: the failure direction is strict.
 */
const declareSubstitutions = (
  upstream: ReadonlyArray<string>,
  removedAt: ReadonlyArray<number>,
  added: ReadonlyArray<string>,
  addedAt: ReadonlyArray<number>,
  lineMarked: ReadonlySet<number>,
  into: Set<number>,
): void => {
  if (added.length !== addedAt.length) return;
  const removedSet = new Set(removedAt);
  const postToAdded = new Map<number, number>();
  for (const [index, post] of addedAt.entries()) {
    if (added[index] === undefined || postToAdded.has(post)) return;
    postToAdded.set(post, index);
  }
  const sortedPosts = [...postToAdded.keys()].toSorted((left, right) => left - right);
  let gapRemovals: Array<number> = [];
  let gapAdds: Array<number> = [];
  let removalsSoFar = 0;
  let consumed = 0;
  let nextPost = 0;
  const flush = () => {
    if (gapRemovals.length > 0 && gapAdds.length > 0)
      if (gapAdds.every((index) => lineMarked.has(index + 1)))
        for (const pre of gapRemovals) into.add(pre);
    gapRemovals = [];
    gapAdds = [];
  };
  for (let pre = 1; pre <= upstream.length + 1; pre += 1) {
    if (pre <= upstream.length && removedSet.has(pre)) {
      gapRemovals.push(pre);
      removalsSoFar += 1;
      continue;
    }
    // A retained pre line lands at post `pre - removalsSoFar + consumed`; every addition at or
    // below that slot — each consumption shifting the boundary by one — fell in the gap this
    // retained line closes. Additions consumed while no gap is open are pure inserts before
    // the first removal and declare nothing.
    while (
      nextPost < sortedPosts.length &&
      (sortedPosts[nextPost] ?? 0) <= pre - removalsSoFar + consumed
    ) {
      const index = postToAdded.get(sortedPosts[nextPost] ?? -1);
      if (index === undefined) return;
      if (gapRemovals.length > 0) gapAdds.push(index);
      nextPost += 1;
      consumed += 1;
    }
    flush();
  }
  while (nextPost < sortedPosts.length) {
    const index = postToAdded.get(sortedPosts[nextPost] ?? -1);
    if (index === undefined) return;
    if (gapRemovals.length > 0) gapAdds.push(index);
    nextPost += 1;
  }
  flush();
};

/** The trailing marker removed in either form, leaving the code the hook classifies. */
const stripForkHookSuffix = (line: string): string =>
  stripForkHookLineMarker(line).replace(FORK_HOOK_BLOCK_SUFFIX, "");

/**
 * A `<>` or `</>` added only to give a marker pair a JSX parent. A JSX comment needs one, so
 * hooking an expression that has none forces a fragment, and those two lines fall outside the
 * region they exist to open. Adjacency is measured in the added lines, which is where the pair
 * and its fragment meet however much unchanged code sits between them in the file.
 */
const isFragmentScaffold = (added: ReadonlyArray<string>, index: number): boolean => {
  const line = added[index]?.trim();
  if (line === "<>") return FORK_HOOK_JSX_OPEN.test(added[index + 1] ?? "");
  if (line === "</>") return FORK_HOOK_JSX_END.test(added[index - 1] ?? "");
  return false;
};

export interface ForkHookSeamCommit {
  readonly short: string;
  readonly domain: string;
  readonly tier?: string;
  readonly upstreamable?: string;
}

export interface ForkHookSeamChange {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

export interface ForkHookSeamInput {
  readonly commit: ForkHookSeamCommit;
  readonly files: ReadonlyArray<string>;
  readonly changedLines: ReadonlyMap<string, ForkHookSeamChange>;
  /** Pre-image line numbers per path, index-aligned with `changedLines`' `removed`. */
  readonly removedPositions: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Post-image line numbers per path, index-aligned with `changedLines`' `added`. */
  readonly addedPositions: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly upstreamFiles: ReadonlySet<string>;
  readonly forkHooks: ReadonlySet<string>;
  /**
   * The target-tree lines, in file order, of the touched upstream-owned files, the same read
   * the upstream-test append-only rule makes. A file with no entry refuses
   * every removal in it: an unread tree is not evidence the line was the fork's.
   */
  readonly upstreamLines: ReadonlyMap<string, ReadonlyArray<string>>;
}

export const forkHookSeamWarnings = (input: ForkHookSeamInput): ReadonlyArray<string> => {
  // The exemption needs both trailers: an upstreamable bugfix, not one alone.
  if (input.commit.tier === "bugfix" && input.commit.upstreamable === "yes") return [];
  const details: Array<string> = [];
  for (const path of [...input.files].toSorted()) {
    if (!input.upstreamFiles.has(path)) continue;
    if (GENERATED_HOOK_PATH.test(path)) continue;
    const change = input.changedLines.get(path);
    if (change === undefined) continue;

    const addedText = change.added.join("\n");
    const hooks = parseForkHookMarkers(addedText);
    const marked = new Set<number>();
    for (const hook of hooks) for (let n = hook.startLine; n <= hook.endLine; n += 1) marked.add(n);

    const unmarked: Array<string> = [];
    const constructViolations: Array<string> = [];
    for (const [index, line] of change.added.entries()) {
      if (marked.has(index + 1)) {
        const region = hooks.find(
          (hook) => hook.kind === "jsx" && index + 1 > hook.startLine && index + 1 < hook.endLine,
        );
        if (region !== undefined && !FORK_HOOK_JSX_END.test(line) && JSX_HOOK_FLOW.test(line))
          constructViolations.push(line);
        continue;
      }
      if (line.includes("fork-hook:")) continue; // cause (c) counts the marker
      if (isFragmentScaffold(change.added, index)) continue;
      unmarked.push(line);
    }
    // Each line marker is itself the whole hook — the statement its span covers — so a
    // multi-line hook is classified by its first line (`import {`), and a property/spread must
    // name a fork identifier. Both suffix forms reach the check: the grammar mandates the block
    // form wherever `//` would not be a comment, so gating on the line form alone exempted every
    // hook inside a JSX attribute list, an object literal, or an expression.
    for (const hook of hooks) {
      if (hook.kind !== "line") continue;
      const markerLine = change.added[hook.endLine - 1];
      if (markerLine === undefined || !isForkHookSuffixLine(markerLine)) continue;
      const classified =
        hook.startLine === hook.endLine
          ? markerLine
          : (change.added[hook.startLine - 1] ?? markerLine);
      const code = stripForkHookSuffix(classified);
      if (code.trim().length === 0) continue;
      if (HOOK_IMPORT.test(code)) continue;
      if (HOOK_SINGLE_CALL.test(code)) continue;
      if (HOOK_CONST_FROM_CALL.test(code)) continue;
      if (HOOK_REEXPORT.test(code)) continue;
      // A branch opener is one construct only when the marker closes a multi-line block; a
      // one-line control-flow statement is still a second construct smuggled into the hook.
      if (hook.startLine !== hook.endLine && HOOK_BRANCH.test(code) && HOOK_FORK_NAMED.test(code))
        continue;
      if (HOOK_PROPERTY.test(code) && HOOK_FORK_NAMED.test(code)) continue;
      constructViolations.push(markerLine);
    }

    if (unmarked.length > 0)
      details.push(
        `${path}: adds ${unmarked.length} line(s) outside a marked fork-hook; mark each hook line with ` +
          "`// fork-hook: <domain>/<name>`" +
          " or move the logic to a fork-owned file",
      );

    // A removed line is an upstream removal only when the target blob carries it at the
    // hunk's pre-image position — line-set membership once counted a fork `});` as a
    // deletion of every upstream `});`. Earlier fork commits in the stack can shift the
    // file off the target blob elsewhere, so a miss falls back to a bounded window of
    // ±3 lines before the line counts as the fork's own. A removal paired with an
    // addition equal to it plus a trailing fork-hook marker — either suffix form, or the JSX
    // pair — is a marker attach, never a rewrite. A removal whose text a marked JSX region
    // re-adds is the same fact one level out: wrapping an upstream element in a fork boundary
    // re-indents every line of it, and the doctrine lists one JSX element as an allowed
    // construct, which only exists via a wrap. And a removal the positional alignment explains —
    // the fork-side gap it left falls inside a marked span, judged on the fork side rebuilt
    // from the blob and the diff's positions — is a declared substitution: the replacing line
    // carries the marker. The comparison is `.trim()`, so it is
    // indentation-blind exactly like the marker attach above; a real deletion inside a region
    // matches no added line and is still charged.
    const upstream = input.upstreamLines.get(path);
    const positions = input.removedPositions.get(path);
    const markerStripped = new Set(
      change.added
        .filter(
          (line) =>
            isForkHookSuffixLine(line) ||
            FORK_HOOK_JSX_OPEN.test(line) ||
            FORK_HOOK_JSX_END.test(line),
        )
        .map((line) =>
          stripForkHookSuffix(line)
            .replace(/\s*\{\/\*\s*fork-hook(?:-end)?[^*]*\*\/\}\s*/g, "")
            .trim(),
        ),
    );
    // The lines a marked JSX region adds between its markers, by trimmed text.
    const regionAdded = new Set(
      hooks
        .filter((hook) => hook.kind === "jsx")
        .flatMap((hook) => change.added.slice(hook.startLine, hook.endLine - 1))
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    // The walk's positional rule, judged by the same alignment the sync walk runs: a removed
    // upstream line whose removal position the alignment shows inside a marked span is a
    // declared substitution — the replacing line carries the marker — and is not reshape debt.
    // The judge runs on real positions, so the added lines are put back where the diff says
    // they landed: the fork side is rebuilt from the blob and the diff's own position arrays.
    // Two strictness gates keep the charge on every shape the rule does not declare:
    //
    // · Block purity. The diff groups one change block as its removals followed by its
    //   additions, and the additions that landed in a removal's gap are the lines that replaced
    //   it. Only when *every* addition in the gap is a line-kind marked hook is the removal
    //   declared; a block that mixes marked hooks, an unmarked line, or a JSX region with the
    //   removal charges exactly as before — a JSX region may only wrap upstream lines, and an
    //   unmarked line in the gap means the seam was never declared.
    // · The alignment itself. Even a pure block charges when the alignment still shows the
    //   removal outside every marked span.
    // Any shape that will not reconstruct — an unread tree, missing positions, an addition the
    // blob cannot place — leaves both gates closed and charges exactly as before.
    const addedPositions = input.addedPositions.get(path);
    const lineMarked = new Set<number>();
    for (const hook of hooks)
      if (hook.kind === "line")
        for (let n = hook.startLine; n <= hook.endLine; n += 1) lineMarked.add(n);
    const declaredSubstitution = new Set<number>();
    const unexplainedAt = new Set<number>();
    if (upstream !== undefined && positions !== undefined && addedPositions !== undefined) {
      declareSubstitutions(
        upstream,
        positions,
        change.added,
        addedPositions,
        lineMarked,
        declaredSubstitution,
      );
      const forkText = forkSideOfDiff(upstream, positions, change.added, addedPositions);
      const markedPost = new Set<number>(
        [...lineMarked]
          .map((index) => addedPositions[index - 1])
          .filter((post): post is number => post !== undefined),
      );
      if (forkText !== null)
        for (const line of unexplainedRemovalLines(upstream.join("\n"), forkText, markedPost))
          unexplainedAt.add(line);
    }
    const removedUpstream =
      upstream === undefined
        ? change.removed
        : change.removed.filter((line, index) => {
            const at = positions?.[index];
            if (at === undefined) return false;
            const matched = [0, -1, 1, -2, 2, -3, 3].some(
              (offset) => upstream[at - 1 + offset]?.trim() === line.trim(),
            );
            if (!matched) return false;
            // A declared substitution — pure block, alignment-explained — exempts outright.
            if (declaredSubstitution.has(at) && !unexplainedAt.has(at)) return false;
            const trimmed = line.trim();
            return !markerStripped.has(trimmed) && !regionAdded.has(trimmed);
          });
    if (removedUpstream.length > 0)
      details.push(
        `${path}: removes or rewrites ${removedUpstream.length} upstream line(s); a fork-hook never deletes upstream code — record the deletion as reshape debt instead`,
      );

    const unmanifested = [
      ...new Set(hooks.map((hook) => hook.key).filter((key) => !input.forkHooks.has(key))),
    ];
    if (unmanifested.length > 0)
      details.push(
        `${path}: fork-hook marker(s) ${unmanifested.map((key) => `\`${key}\``).join(", ")} missing from FORK_HOOKS in scripts/lib/fork-hooks.ts`,
      );

    if (constructViolations.length > 0)
      details.push(
        `${path}: marked hook is more than one construct (${constructViolations.length} line(s)); a hook is one import, one call, one const from a single fork call, one JSX element, or one fork-named property/spread`,
      );
  }
  return details;
};
