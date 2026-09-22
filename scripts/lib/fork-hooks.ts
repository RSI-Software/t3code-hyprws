// The fork-hook seam model. A `fork-hook:` marker in an upstream-owned source
// fork job steps 2 and 5: the hook seam
// Gate: none — pure seam model; read by the hook guard (fork:ci) and hook re-apply (sync tip).
// file is the whole declaration of a seam: there is no hand-kept manifest, and
// nothing outside the marked source decides whether a hook exists
// (RSI-Software/t3code-hyprws#1155). `deriveForkHooks` reads the markers at the
// fork tip and derives every entry the sync walk re-applies.
//
// Three marker forms:
//
// - a trailing `// fork-hook: <domain>/<name>` on a one-line hook (an import,
//   a call, a `const`, a property/spread);
// - `{/* fork-hook: <domain>/<name> */}` … `{/* fork-hook-end *` + `/}`
//   (the end-marker JSX comment) around a multi-line JSX construct;
// - a trailing `/* fork-hook: <domain>/<name> */` for one-line hooks in
//   languages where `//` is not a comment (CSS).
//
// A hook is exactly one construct and never removes or modifies an upstream
// line; `forkHookConstructViolation` is that doctrine as code. An unmatched
// JSX pair or an unknown domain fails the derivation with `path:line`, and a
// marker mid-comment marks nothing.

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FORK_DOMAINS } from "./fork-trailers.ts";

/**
 * Where the hook sits in its file, derived from the marked span's context at
 * the fork tip: the shortest run of immediately preceding lines that carry no
 * marker of their own and occur exactly once in the file with every marked span
 * removed. Re-apply puts the hook back directly after that run, so the anchor
 * needs no typed kinds — an import block, a collection member and a JSX child
 * are all "after these lines".
 */
export interface ForkHookAnchor {
  readonly context: ReadonlyArray<string>;
}

export interface ForkHookEntry {
  readonly key: string;
  /** The upstream-owned file the hook lives in. */
  readonly path: string;
  readonly anchor: ForkHookAnchor;
  /** The marked span in the fork tip's text of `path`. */
  readonly span: ParsedForkHook;
}

/** Every derived hook, in file path order and marker order within a file. */
export type ForkHooksManifest = ReadonlyArray<ForkHookEntry>;

export const forkHookKey = (domain: string, name: string): string => `${domain}/${name}`;

// The comment must close the line: a marker mid-comment marks nothing.
export const FORK_HOOK_LINE_MARKER = /^\/\/\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*$/;
export const FORK_HOOK_LINE_SUFFIX = /\s+\/\/\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*$/;
export const FORK_HOOK_BLOCK_SUFFIX = /\s+\/\*\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*\*\/\s*$/;
export const FORK_HOOK_JSX_OPEN = /\{\/\*\s*fork-hook:\s*([\w-]+)\/([\w-]+)\s*\*\/\}/;
export const FORK_HOOK_JSX_END = /\{\/\*\s*fork-hook-end\s*\*\/\}/;

/**
 * A single-construct re-export hook, recognised for the `after-decl` anchor: a
 * fork export placed immediately after an upstream declaration of the same
 * symbol (`export { X }; // fork-hook: <domain>/<name>`, `export type { T };`).
 */
export const HOOK_REEXPORT = /^\s*export\s+(type\s+)?\{\s*[\w$]+\s*\};?\s*$/;

export const stripForkHookLineMarker = (line: string): string =>
  line.replace(FORK_HOOK_LINE_SUFFIX, "");

/** A marker found in source: its key and the line span it marks (1-based, inclusive). */
export interface ParsedForkHook {
  readonly key: string;
  readonly domain: string;
  readonly name: string;
  /** `line`: the marker line is the whole hook. `jsx`: open marker to end marker. */
  readonly kind: "line" | "jsx";
  readonly startLine: number;
  readonly endLine: number;
  /**
   * `true` when the span was resolved in the replayed commit's text from the fork tip's marker
   * rather than read from an in-file marker (RSI-Software/t3code-hyprws#1030). The marked lines
   * carry no marker there, so re-insertion skips the marker-syntax assertion and the raw lines
   * — unmarked — are what lands. `parseForkHookMarkers` never sets it.
   */
  readonly overlay?: boolean;
}

/** Literal state after scanning a prefix of the file: bracket depth and open string/template. */
interface LiteralScan {
  readonly depth: number;
  /** The open quote character, when the scan sits inside a string or template text. */
  readonly quote: string | null;
  /** Open `${` frames, each counting the `{` nested inside the interpolation. */
  readonly frames: ReadonlyArray<number>;
  /** The last significant code character seen outside strings and comments. */
  readonly lastCode: string;
}

const INITIAL_SCAN: LiteralScan = { depth: 0, quote: null, frames: [], lastCode: "" };

const scanLiteralLine = (line: string, start: LiteralScan): LiteralScan => {
  let { depth, quote, lastCode } = start;
  const frames = [...start.frames];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (quote === "`") {
        if (char === "`") quote = null;
        else if (char === "$" && line[index + 1] === "{") {
          index += 1;
          frames.push(0);
          quote = null;
        }
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && line[index + 1] === "/") break;
    if (char === "/" && line[index + 1] === "*") {
      const end = line.indexOf("*/", index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "{") {
      if (frames.length > 0) frames[frames.length - 1] = (frames[frames.length - 1] ?? 0) + 1;
      else depth += 1;
      // An opening brace is a statement terminator for the backward walk: a hook that is the
      // first member of a block or object literal has it as its whole preceding context.
      lastCode = "{";
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "}") {
      const top = frames.length - 1;
      if (top >= 0 && (frames[top] ?? 0) === 0) {
        frames.pop();
        quote = "`";
      } else if (top >= 0) frames[top] = (frames[top] ?? 0) - 1;
      else depth -= 1;
    }
    if (char !== " " && char !== "\t") lastCode = char;
  }
  return { depth, quote, frames, lastCode };
};

const COMMENT_ONLY = /^(?:\/\/|\/\*|\*(?:\/|$))/;

/**
 * The first line (1-based) of the statement a trailing marker on `markerLine` closes, found by
 * walking backwards: while `()[]{}` brackets or string/template literals are still open, or the
 * previous line neither ends a statement (`;`, `{`, `,` as the last code character outside any
 * literal, or a balanced `}` closing a block) nor is blank or
 * comment-only, the statement continues upward. `null` when the start cannot be proven — the
 * marker sits inside a string or template text, or a stray close leaves the file unbalanced.
 * Pure and line-based; there is deliberately no parser dependency.
 *
 * "Open" is judged against the depth the statement itself ends at, not against the file's top
 * level: a hook inside a function body sits at depth 1 for its whole life, and comparing with 0
 * would walk the span out to the enclosing declaration and swallow upstream lines with it.
 */
export const statementStartLine = (
  lines: ReadonlyArray<string>,
  markerLine: number,
): number | null => {
  const states: Array<LiteralScan> = [];
  let state = INITIAL_SCAN;
  for (const line of lines) {
    states.push(state);
    state = scanLiteralLine(line, state);
  }
  states.push(state);
  const index = markerLine - 1;
  const entered = states[index];
  const exited = states[index + 1];
  if (entered === undefined || exited === undefined) return null;
  // The statement's own nesting: where the marker line leaves the scan.
  const baseline = exited.depth;
  const frameDepth = exited.frames.length;
  // A marker inside a string or template text, or a file already unbalanced before it, is
  // unprovable. An open `${` frame is code, not text — the walk still applies.
  if (entered.quote !== null || entered.depth < 0 || baseline < 0 || exited.quote !== null)
    return null;
  let at = index;
  while (at > 0) {
    const previous = states[at];
    if (previous === undefined) return null;
    if (previous.depth < baseline) break; // the line above is outside the statement's scope
    // A blank or comment-only line, or a statement terminator at the statement's own nesting,
    // only ends the walk when no bracket or literal is still open across it; inside an open
    // construct the walk continues.
    if (
      previous.depth === baseline &&
      previous.quote === null &&
      previous.frames.length === frameDepth
    ) {
      const text = (lines[at - 1] ?? "").trim();
      if (text === "" || COMMENT_ONLY.test(text)) break;
      if (
        previous.lastCode === ";" ||
        previous.lastCode === "{" ||
        previous.lastCode === "," ||
        previous.lastCode === "}"
      )
        break;
    }
    at -= 1;
  }
  const start = states[at];
  // The state the first line is entered with sits at the statement's own nesting, or below it when
  // the statement is what opens the brackets the marker line is still inside.
  if (
    start === undefined ||
    start.depth > baseline ||
    start.quote !== null ||
    start.frames.length > frameDepth
  )
    return null;
  return at + 1;
};

/**
 * Every marker in one file's text, in source order. A line marker covers the whole statement it
 * closes, walked back from the marker line; a JSX open marker covers through the next end marker (or end of
 * file when unclosed, so a missing end marker still bounds the
 * region rather than swallowing the rest of the file silently as "unmarked").
 */
export const parseForkHookMarkers = (content: string): ReadonlyArray<ParsedForkHook> => {
  const lines = content.split("\n");
  const hooks: Array<ParsedForkHook> = [];
  let open: { key: string; domain: string; name: string; startLine: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (open !== null) {
      if (FORK_HOOK_JSX_END.test(line)) {
        hooks.push({ ...open, kind: "jsx", endLine: lineNumber });
        open = null;
      }
      continue;
    }
    const jsx = FORK_HOOK_JSX_OPEN.exec(line);
    if (jsx !== null) {
      open = {
        key: forkHookKey(jsx[1] ?? "", jsx[2] ?? ""),
        domain: jsx[1] ?? "",
        name: jsx[2] ?? "",
        startLine: lineNumber,
      };
      continue;
    }
    const line1 = FORK_HOOK_LINE_SUFFIX.exec(line) ?? FORK_HOOK_BLOCK_SUFFIX.exec(line);
    if (line1 !== null) {
      // The marker covers the whole statement it closes; an unprovable start is the same
      // refusal a malformed marker gets — the marker marks nothing.
      const startLine = statementStartLine(lines, lineNumber);
      if (startLine === null) continue;
      hooks.push({
        key: forkHookKey(line1[1] ?? "", line1[2] ?? ""),
        domain: line1[1] ?? "",
        name: line1[2] ?? "",
        kind: "line",
        startLine,
        endLine: lineNumber,
      });
    }
  }
  if (open !== null) hooks.push({ ...open, kind: "jsx", endLine: lines.length });
  return hooks;
};

/** A well-formed manifest key: `<domain>/<name>` with known domain segments. */
export const isWellFormedForkHookKey = (key: string): boolean => {
  const match = /^([\w-]+)\/([\w-]+)$/.exec(key);
  return (
    match !== null &&
    (FORK_DOMAINS as readonly string[]).includes(match[1] ?? "") &&
    (match[2] ?? "").length > 0
  );
};

// The marker-construct doctrine (RSI-Software/t3code-hyprws#1155 folded the
// authoring guard's classifier in here, next to the parser it judges). A marked
// line hook must be exactly one of these shapes; the property/spread shape
// additionally names a fork identifier, the others are structural. `@import` is
// the CSS spelling of the import construct: a fork sheet is pulled in that way.
const HOOK_IMPORT = /^\s*(?:@?import\b|export\s+\{[^}]*\}\s*from\b|export\s*\*)/;
const HOOK_SINGLE_CALL =
  /^(?!\s*(?:if|for|while|switch|catch|return)\s*\()\s*[A-Za-z_$][\w$.]*\s*\(/;
// A multi-line branch dispatch carried whole behind a closing-brace marker: the condition names
// the fork, so the whole statement is still one fork construct.
const HOOK_BRANCH = /^\s*(?:if|for|while|switch)\s*\(/;
// `yield*` and `await` are how a single call is bound in the two idioms this repo is written in —
// Effect generators on the server, async code everywhere — so the prefix is part of the binding,
// not a second construct smuggled in behind it.
const HOOK_CONST_FROM_CALL =
  /^\s*(?:export\s+)?const\s+[\w$]+(?:\s*:\s*[^=]+)?\s*=\s*(?:yield\s*\*\s*|await\s+)?[A-Za-z_$][\w$.]*\s*\(/;
const HOOK_FORK_NAMED = /[Ff]ork|Hypr|hyprws/;
// The spread half covers both spellings of the same construct: an object spread and its JSX
// attribute form, `{...forkProps}`, which is the shape that avoids rewriting upstream prop lines.
const HOOK_PROPERTY =
  /^\s*(?:\{\.\.\.[A-Za-z_$][\w$.]*\}|\.\.\.[A-Za-z_$][\w$.]*|[\w$"']+\s*:\s*[A-Za-z_$][\w$.]*)\s*,?\s*$/;
/**
 * Inside a JSX hook only an in-scope element is allowed — no derived rows, no statements. These
 * are the shapes that smuggle a second construct into a marked region.
 */
export const JSX_HOOK_FLOW =
  /\b(?:if|for|while|switch)\s*\(|^\s*(?:const|let|var|function|return)\b|\.\s*(?:map|filter|flatMap|reduce|forEach)\s*\(/;

/**
 * Whether `code` — one hook's classifying line, marker already stripped — is more than one
 * construct. A multi-line hook is classified by its first line (`import {`), and a branch opener
 * counts as one construct only when the marker closes a multi-line block: a one-line control-flow
 * statement is a second construct smuggled in behind the marker.
 */
export const forkHookConstructViolation = (code: string, multiline: boolean): boolean => {
  if (code.trim().length === 0) return false;
  if (HOOK_IMPORT.test(code)) return false;
  if (HOOK_SINGLE_CALL.test(code)) return false;
  if (HOOK_CONST_FROM_CALL.test(code)) return false;
  if (HOOK_REEXPORT.test(code)) return false;
  if (multiline && HOOK_BRANCH.test(code) && HOOK_FORK_NAMED.test(code)) return false;
  if (HOOK_PROPERTY.test(code) && HOOK_FORK_NAMED.test(code)) return false;
  return true;
};

/** A derivation refusal, always naming the marker it refused at as `path:line`. */
export class ForkHookDeclarationError extends Error {}

const declarationRefusal = (path: string, line: number, reason: string): never => {
  throw new ForkHookDeclarationError(`${path}:${line}: ${reason}`);
};

/**
 * The unmatched half of a JSX marker pair, as a 1-based line, or `null` when every open marker
 * has an end marker and no end marker stands alone. `parseForkHookMarkers` deliberately bounds an
 * unclosed region at end of file rather than swallowing the rest of the file silently; the
 * derivation refuses the same shape outright.
 */
export const forkHookPairingError = (content: string): { readonly line: number } | null => {
  let open: number | null = null;
  for (const [index, line] of content.split("\n").entries()) {
    if (open === null && FORK_HOOK_JSX_END.test(line)) return { line: index + 1 };
    if (open !== null && FORK_HOOK_JSX_END.test(line)) {
      open = null;
      continue;
    }
    if (open === null && FORK_HOOK_JSX_OPEN.test(line)) open = index + 1;
  }
  return open === null ? null : { line: open };
};

/** The longest context a derived anchor carries before it gives up on being unique. */
const MAX_ANCHOR_CONTEXT = 24;

/** How many times `context` occurs in `lines` as one contiguous run of exact matches. */
const contextRuns = (
  lines: ReadonlyArray<string>,
  context: ReadonlyArray<string>,
  limit = Number.POSITIVE_INFINITY,
): number => {
  if (context.length === 0) return 1;
  let runs = 0;
  for (let start = 0; start + context.length <= lines.length; start += 1) {
    let matched = true;
    for (const [offset, text] of context.entries())
      if (lines[start + offset] !== text) {
        matched = false;
        break;
      }
    if (matched) {
      runs += 1;
      if (runs >= limit) return runs;
    }
  }
  return runs;
};

/** The shortest unique run of the `before` lines preceding a hook, capped at `MAX_ANCHOR_CONTEXT`. */
const anchorFor = (unmarked: ReadonlyArray<string>, before: number): ForkHookAnchor => {
  const most = Math.min(MAX_ANCHOR_CONTEXT, before);
  for (let size = 1; size <= most; size += 1) {
    const context = unmarked.slice(before - size, before);
    if (contextRuns(unmarked, context, 2) === 1) return { context };
  }
  return { context: unmarked.slice(before - most, before) };
};

/** Every hook one file declares, in marker order. Refuses with `path:line`; see the contract above. */
export const deriveForkHooksIn = (path: string, content: string): ForkHooksManifest => {
  const unmatched = forkHookPairingError(content);
  if (unmatched !== null)
    declarationRefusal(
      path,
      unmatched.line,
      "unmatched fork-hook JSX marker; every `{/* fork-hook: <domain>/<name> */}` needs its `fork-hook-end`",
    );
  const parsed = parseForkHookMarkers(content);
  // A hook inside another hook's span is carried by the enclosing construct: the outer marker's
  // lines already include it, so deriving both would re-insert the inner one twice. The outer
  // declaration wins and the inner marker rides along inside it.
  const hooks = parsed.filter(
    (hook) =>
      !parsed.some(
        (outer) =>
          outer !== hook && outer.startLine <= hook.startLine && outer.endLine >= hook.endLine,
      ),
  );
  if (hooks.length === 0) return [];
  const lines = content.split("\n");
  const marked = new Set<number>();
  for (const hook of parsed)
    for (let line = hook.startLine; line <= hook.endLine; line += 1) marked.add(line);
  // The file as the upstream base carries it: every marked span removed, so an anchor is written
  // in lines the merged upstream text still has.
  const unmarked: Array<string> = [];
  const before: Array<number> = [0];
  for (let line = 1; line <= lines.length; line += 1) {
    before[line] = unmarked.length;
    if (!marked.has(line)) unmarked.push(lines[line - 1] ?? "");
  }
  return hooks.map((span) => {
    if (!(FORK_DOMAINS as readonly string[]).includes(span.domain))
      declarationRefusal(
        path,
        span.kind === "line" ? span.endLine : span.startLine,
        `unknown fork domain \`${span.domain}\`; a marker's domain must be one of FORK_DOMAINS`,
      );
    return { key: span.key, path, anchor: anchorFor(unmarked, before[span.startLine] ?? 0), span };
  });
};

/** The manifest a tree of upstream-owned files declares, in path order then marker order. */
export const deriveForkHooks = (tree: ReadonlyMap<string, string>): ForkHooksManifest =>
  [...tree.keys()].toSorted().flatMap((path) => deriveForkHooksIn(path, tree.get(path) ?? ""));

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodePath.dirname(import.meta.dirname)));

/** The marked files of the working tree, read through `git grep` so ignored paths never appear. */
export const readForkHookTree = (root = REPO_ROOT): ReadonlyMap<string, string> => {
  const found = NodeChildProcess.spawnSync(
    "git",
    ["grep", "-l", "--", "fork-hook:", "--", "apps", "packages"],
    { cwd: root, encoding: "utf8" },
  );
  const paths = (found.stdout ?? "").split("\n").filter((path) => path.trim() !== "");
  return new Map(
    paths.map((path) => [path, NodeFS.readFileSync(NodePath.join(root, path), "utf8")]),
  );
};

let cached: ForkHooksManifest | null = null;

/**
 * The derived manifest of the working tree, read once per process. Callers that need another tree
 * — a rehearsal worktree, the fork tip's blobs — build the map themselves and call
 * `deriveForkHooks`.
 */
export const forkHookManifest = (): ForkHooksManifest => {
  cached ??= deriveForkHooks(readForkHookTree());
  return cached;
};
