// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// Hook guard step (fork:ci step 2): for a fork commit touching an
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
}

export interface HookGuardInput {
  readonly commit: HookGuardCommit;
  readonly files: ReadonlyArray<string>;
  readonly changedLines: ReadonlyMap<string, HookGuardChange>;
  readonly upstreamFiles: ReadonlySet<string>;
}

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

    const addedText = change.added.join("\n");
    const hooks = parseForkHookMarkers(addedText);
    const marked = new Set<number>();
    for (const hook of hooks) for (let n = hook.startLine; n <= hook.endLine; n += 1) marked.add(n);

    const unmarked: Array<string> = [];
    for (const [index, line] of change.added.entries()) {
      if (marked.has(index + 1)) continue;
      if (line.includes("fork-hook:")) continue;
      if (isFragmentScaffold(change.added, index)) continue;
      unmarked.push(line);
    }
    const code = unmarked.filter(
      (line) => !isForkHookSuffixLine(line) && line.trim() !== "" && /[A-Za-z_$]/.test(line),
    );
    if (code.length === 0) continue;
    const sample = code.slice(0, 3).map((line) => line.trim());
    details.push(
      `${path}: ${code.length} added line(s) outside a marked hook (first: ${sample.join(" / ")}); wrap the insertion in a fork-hook marker`,
    );
  }
  return details;
};
