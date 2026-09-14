// The re-apply stage the sync walk runs after keep-both declines (RSI-Software/t3code-hyprws#953):
// when upstream rewrote a file a fork commit also touched, the marked hook lines are re-inserted
// from the manifest instead of handing the seam to a human.
//
// The rule is deliberately narrow. A hook is re-applied only when its manifest anchor resolves to
// exactly one site in the merged upstream text, and the hook's exact marked line (or JSX pair) is
// still readable from the fork side. Zero sites, several sites, an unreadable hook line, or a JSX
// pair whose end marker cannot be placed are all a refusal — a dead hook that typechecks is worse
// than a stop, so there is deliberately no file-end fallback. Re-insertion only ever inserts: an
// upstream line is never deleted or rewritten to make room for a hook.

import {
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
      /** The exact marked line(s) from the fork side, re-indented for the merged text. */
      readonly lines: ReadonlyArray<string>;
      /** Insert the lines before this 0-based line index of the merged text. */
      readonly at: number;
    }
  | { readonly status: "refuse"; readonly reason: string };

const escapeRegExp = (symbol: string): string => symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const lineIndent = (line: string): string => line.match(/^\s*/)?.[0] ?? "";

/** Shift a block's first-line indentation to `indent`, keeping the block's relative shape. */
const reindented = (lines: ReadonlyArray<string>, indent: string): ReadonlyArray<string> => {
  const base = lineIndent(lines[0] ?? "");
  return lines.map((line) =>
    line.trim() === "" ? "" : indent + line.slice(Math.min(base.length, line.length)),
  );
};

/**
 * Statement-level declarations of one symbol: `const|let|var|function|class|interface|type|enum`.
 * A `collection` anchor's subject and an `after-decl` anchor's neighbour are always one of these.
 */
const declarationLines = (lines: ReadonlyArray<string>, symbol: string): ReadonlyArray<number> => {
  const declaration = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${escapeRegExp(symbol)}\\b`,
  );
  const found: Array<number> = [];
  for (const [index, line] of lines.entries()) if (declaration.test(line)) found.push(index);
  return found;
};

/** Call sites of one symbol, member calls included (`inFlightTools.set(`). */
const callSites = (lines: ReadonlyArray<string>, symbol: string): ReadonlyArray<number> => {
  const call = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}\\s*\\(`);
  const found: Array<number> = [];
  for (const [index, line] of lines.entries()) if (call.test(line)) found.push(index);
  return found;
};

/**
 * A JSX element `<Symbol …>` whose anchor can carry a hook: exactly one open and one close tag in
 * the file, the open not self-closing. Anything else — zero, a nesting the tag count cannot prove,
 * additional occurrences — is ambiguity and refuses one level up.
 */
const jsxParentLines = (
  lines: ReadonlyArray<string>,
  symbol: string,
): { readonly open: number; readonly close: number } | null => {
  const element = new RegExp(`</?${escapeRegExp(symbol)}(?=[\\s/>])`);
  const hits: Array<{ readonly index: number; readonly tag: string }> = [];
  for (const [index, line] of lines.entries()) {
    const match = element.exec(line);
    if (match !== null) hits.push({ index, tag: match[0] ?? "" });
  }
  if (hits.length !== 2) return null;
  const open = hits[0];
  const close = hits[1];
  if (open === undefined || close === undefined || open.tag.startsWith("</")) return null;
  if ((lines[open.index] ?? "").includes("/>")) return null;
  return { open: open.index, close: close.index };
};

/** Read one hook's exact marked text out of the fork side; `null` when the marker is unreadable. */
const forkHookLines = (fork: string, hook: ParsedForkHook): ReadonlyArray<string> | null => {
  const lines = fork.split("\n");
  const slice = lines.slice(hook.startLine - 1, hook.endLine);
  if (slice.length !== hook.endLine - hook.startLine + 1) return null;
  const body = slice.join("\n");
  if (hook.kind === "line" ? !FORK_HOOK_LINE_SUFFIX.test(body) : !FORK_HOOK_JSX_OPEN.test(body))
    return null;
  if (hook.kind === "jsx" && !FORK_HOOK_JSX_END.test(slice[slice.length - 1] ?? "")) return null;
  return slice;
};

/**
 * The last line of the leading import block: whole statements only, so a hook never lands inside a
 * multi-line statement. Leading comment lines, licence headers, and directives (`"use client";`)
 * are skipped; the block itself starts at the first import. `null` when the file opens with
 * anything else — no import block is zero sites, and there is no file-end fallback.
 */
const importBlockEnd = (lines: ReadonlyArray<string>): number | null => {
  const startsStatement = /^(?:import\b|export\s+\{[^}]*\}\s*from\b|export\s*\*)/;
  const preamble = /^(?:\/\/|\/\*|\*\/|\*|['"`])/;
  let begin = 0;
  while (begin < lines.length) {
    const trimmed = (lines[begin] ?? "").trim();
    if (trimmed === "" || preamble.test(trimmed)) {
      begin += 1;
      continue;
    }
    break;
  }
  let end: number | null = null;
  let inStatement = false;
  for (let index = begin; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed === "") break; // prettier-style grouping: a blank line ends the block
    if (!inStatement && !startsStatement.test(trimmed)) break;
    end = index;
    if (trimmed.endsWith(";") || trimmed.endsWith("'") || trimmed.endsWith('"'))
      inStatement = false;
    else inStatement = true;
  }
  return end;
};

/** The 0-based line holding the `}` that closes the `{` at offset `open`; `null` when unbalanced. */
const closingBraceLine = (
  text: string,
  open: number,
  matchDelimiter: matchingDelimiterType,
): number | null => {
  const close = matchDelimiter(text, open, "{", "}");
  if (close === null) return null;
  return text.slice(0, close).split("\n").length - 1;
};

/** Offset of the first `{` at or after the start of line `from`, in the joined text. */
const firstBraceAt = (lines: ReadonlyArray<string>, text: string, from: number): number | null => {
  let offset = lines.slice(0, from).reduce((sum, row) => sum + row.length + 1, 0);
  for (let index = from; index < lines.length; index += 1) {
    const brace = (lines[index] ?? "").indexOf("{");
    if (brace !== -1) return offset + brace;
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return null;
};

type matchingDelimiterType = (
  text: string,
  start: number,
  open: string,
  close: string,
) => number | null;

/**
 * Resolve one manifest hook against the merged upstream text. `matchDelimiter` is the lane's
 * delimiter matcher (reused from `fork-conflict-outcomes.ts`) so the brace scans respect strings
 * and comments instead of counting characters blindly.
 */
const resolveHook = (
  merged: string,
  fork: string,
  hook: ParsedForkHook | undefined,
  anchor: ForkHookAnchor,
  matchDelimiter: matchingDelimiterType,
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

  if (anchor.kind === "import-block") {
    const end = importBlockEnd(lines);
    if (end === null)
      return { status: "refuse", reason: "no import block to anchor the hook after" };
    const indent = lineIndent(lines[end] ?? "");
    return { status: "reinsert", lines: reindented(marked, indent), at: end + 1 };
  }
  if (anchor.kind === "collection") {
    const declarations = declarationLines(lines, anchor.symbol);
    if (declarations.length === 0)
      return {
        status: "refuse",
        reason: `no declaration of \`${anchor.symbol}\` to anchor the hook inside`,
      };
    if (declarations.length > 1)
      return {
        status: "refuse",
        reason: `\`${anchor.symbol}\` is declared ${declarations.length} times; the anchor is ambiguous`,
      };
    const start = declarations[0] ?? 0;
    const open = firstBraceAt(lines, merged, start);
    const close = open === null ? null : closingBraceLine(merged, open, matchDelimiter);
    if (close === null || close <= start)
      return {
        status: "refuse",
        reason: `the body of \`${anchor.symbol}\` has no placeable closing brace`,
      };
    const indent = `${lineIndent(lines[close] ?? "")}  `;
    return { status: "reinsert", lines: reindented(marked, indent), at: close };
  }
  if (anchor.kind === "jsx-parent") {
    const parent = jsxParentLines(lines, anchor.symbol);
    if (parent === null)
      return {
        status: "refuse",
        reason: `no single JSX element \`${anchor.symbol}\` with a placeable closing tag`,
      };
    const closeLine = lines[parent.close] ?? "";
    if (closeLine.trim() !== `</${anchor.symbol}>`)
      return {
        status: "refuse",
        reason: `the closing tag of \`${anchor.symbol}\` shares its line with other JSX; the end marker cannot be placed`,
      };
    const indent = `${lineIndent(closeLine)}  `;
    return { status: "reinsert", lines: reindented(marked, indent), at: parent.close };
  }
  if (anchor.kind === "after-call") {
    const sites = callSites(lines, anchor.symbol);
    if (sites.length === 0)
      return {
        status: "refuse",
        reason: `no call site of \`${anchor.symbol}\` to anchor the hook after`,
      };
    if (sites.length > 1)
      return {
        status: "refuse",
        reason: `\`${anchor.symbol}\` is called ${sites.length} times; the anchor is ambiguous`,
      };
    const site = sites[0] ?? 0;
    return {
      status: "reinsert",
      lines: reindented(marked, lineIndent(lines[site] ?? "")),
      at: site + 1,
    };
  }
  // after-decl: immediately after the declaration's statement ends — the same line for a one-line
  // `export const x = …;`, the closing brace's line for a block-bodied declaration.
  const declarations = declarationLines(lines, anchor.symbol);
  if (declarations.length === 0)
    return {
      status: "refuse",
      reason: `no declaration of \`${anchor.symbol}\` to anchor the hook after`,
    };
  if (declarations.length > 1)
    return {
      status: "refuse",
      reason: `\`${anchor.symbol}\` is declared ${declarations.length} times; the anchor is ambiguous`,
    };
  const start = declarations[0] ?? 0;
  if ((lines[start] ?? "").trimEnd().endsWith(";"))
    return {
      status: "reinsert",
      lines: reindented(marked, lineIndent(lines[start] ?? "")),
      at: start + 1,
    };
  const open = firstBraceAt(lines, merged, start);
  const close = open === null ? null : closingBraceLine(merged, open, matchDelimiter);
  if (close === null)
    return {
      status: "refuse",
      reason: `the statement declaring \`${anchor.symbol}\` has no placeable end`,
    };
  return {
    status: "reinsert",
    lines: reindented(marked, lineIndent(lines[start] ?? "")),
    at: close + 1,
  };
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
 * text the hook's exact marked line is read from; `entries` are the manifest rows for the path.
 */
export const reapplyForkHooks = (
  merged: string,
  fork: string,
  entries: ReadonlyArray<{ readonly key: string; readonly anchor: ForkHookAnchor }>,
  matchDelimiter: matchingDelimiterType,
): ForkHookReapplyResult => {
  const markers = new Map(parseForkHookMarkers(fork).map((hook) => [hook.key, hook]));
  const results = entries.map(({ key, anchor }) => ({
    key,
    outcome: resolveHook(merged, fork, markers.get(key), anchor, matchDelimiter),
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
