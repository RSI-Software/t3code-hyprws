// The `fork-hook-seam` rule, registered in `fork-scan-guards.ts` but kept here:
// that file crossed the 700-line focus limit long ago. The rule is warn-only
// (deliberately outside `ADOPTED_AUTHORING_GUARDS`) until the sweep clears the
// woven-seam stack (RSI-Software/t3code-hyprws#948).
//
// For a fork commit touching an upstream-owned file it warns, one warning per
// file per cause with a line count, on:
//
// (a) added lines outside a marked hook;
// (b) removed or rewritten upstream lines — a hook never deletes upstream code;
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
  FORK_HOOK_JSX_END,
  FORK_HOOK_LINE_SUFFIX,
  parseForkHookMarkers,
  stripForkHookLineMarker,
} from "./fork-hooks.ts";

/** Generated dependency and codegen state no fork domain owns by hand. */
export const GENERATED_HOOK_PATH = /(?:^|\/)pnpm-lock\.yaml$|\.gen\.ts$/;

// A marked line hook must be exactly one of these shapes. The property/spread
// shape additionally names a fork identifier; the others are structural.
const HOOK_IMPORT = /^\s*(?:import\b|export\s+\{[^}]*\}\s*from\b|export\s*\*)/;
const HOOK_SINGLE_CALL = /^\s*[A-Za-z_$][\w$.]*\s*\(/;
const HOOK_CONST_FROM_CALL =
  /^\s*(?:export\s+)?const\s+[\w$]+(?:\s*:\s*[^=]+)?=\s*[A-Za-z_$][\w$.]*\s*\(/;
const HOOK_FORK_NAMED = /[Ff]ork|Hypr|hyprws/;
const HOOK_PROPERTY = /^\s*(?:\.\.\.[A-Za-z_$][\w$.]*|[\w$"']+\s*:\s*[A-Za-z_$][\w$.]*)\s*,?\s*$/;
// Inside a JSX hook only an in-scope element is allowed — no derived rows, no
// statements. These are the shapes that smuggle a second construct in.
const JSX_HOOK_FLOW =
  /\b(?:if|for|while|switch)\s*\(|^\s*(?:const|let|var|function|return)\b|\.\s*(?:map|filter|flatMap|reduce|forEach)\s*\(/;

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
  readonly upstreamFiles: ReadonlySet<string>;
  readonly forkHooks: ReadonlySet<string>;
  /**
   * The target-tree lines of the touched upstream-owned files, the same read
   * the upstream-test append-only rule makes. A file with no entry refuses
   * every removal in it: an unread tree is not evidence the line was the fork's.
   */
  readonly upstreamLines: ReadonlyMap<string, ReadonlySet<string>>;
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
      unmarked.push(line);
    }
    // Each marked line-marker line is itself the whole hook: it must be one
    // construct, and a property/spread must name a fork identifier.
    for (const line of change.added) {
      if (!FORK_HOOK_LINE_SUFFIX.test(line)) continue;
      const code = stripForkHookLineMarker(line);
      if (code.trim().length === 0) continue;
      if (HOOK_IMPORT.test(code)) continue;
      if (HOOK_SINGLE_CALL.test(code)) continue;
      if (HOOK_CONST_FROM_CALL.test(code)) continue;
      if (HOOK_PROPERTY.test(code) && HOOK_FORK_NAMED.test(code)) continue;
      constructViolations.push(line);
    }

    if (unmarked.length > 0)
      details.push(
        `${path}: adds ${unmarked.length} line(s) outside a marked fork-hook; mark each hook line with ` +
          "`// fork-hook: <domain>/<name>`" +
          " or move the logic to a fork-owned file",
      );

    // A removed line that the target tree still carries is an upstream line
    // being deleted or rewritten; a line only the fork ever added is not.
    const upstream = input.upstreamLines.get(path);
    const removedUpstream =
      upstream === undefined
        ? change.removed
        : change.removed.filter((line) => upstream.has(line.trim()));
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
