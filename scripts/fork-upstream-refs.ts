#!/usr/bin/env node

// Refuses fork prose that cites an upstream item outside a code span or fence.
// GitHub turns a live `pingdotgg/t3code#4379` or item URL into a backlink event
// on the upstream thread, posted from the fork's bot account, so the citation is
// wrapped instead of removed: the prose still reads, upstream stays quiet.
// See the upstream citations section of docs/internals/fork-development.md.
//
// A bare `#4379` counts too. GitHub resolves a number this fork has never issued
// against the repository it was forked from, so the plainest-looking reference in
// fork prose is the one that reaches upstream without naming it.
//
// Run it before a body is published; a check that reacts to an existing issue,
// comment, or pull request cannot un-post the backlink that creating it caused.
// docs/internals/scripts.md records what this guard covers and what it does not.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/unstable/cli";

import { FORK_REPOSITORY, UPSTREAM_REPOSITORY } from "./lib/fork-policy.ts";

// The one repository this fork sits above. A reference to any other repository
// is somebody else's business and stays live.
export const UPSTREAM_REPO = UPSTREAM_REPOSITORY;

// Named only so a finding can say how to keep a fork reference linking here.
// `RSI-Software/t3code-hyprws#108` renders as `#108`, so qualifying a number
// costs the prose nothing.
export const FORK_REPO = FORK_REPOSITORY;

// Only the forms GitHub turns into an event on the referenced item are listed.
// The repository URL on its own notifies nobody, so it is not a finding.
const REFERENCE_LABELS = {
  issue: "cross-repo issue reference",
  commit: "cross-repo commit reference",
  url: "upstream item URL",
  number: "bare item number, resolved upstream when this fork has no such item",
} as const;

export type UpstreamReferenceKind = keyof typeof REFERENCE_LABELS;

export interface UpstreamReference {
  readonly kind: UpstreamReferenceKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// An item URL only carries a backlink when it names an item: a number for an
// issue, pull request, or discussion, and a hex sha for a commit. `/issues/new`,
// `/pull/new/main`, and `/discussions/categories/ideas` create nothing and stay
// live, so the identifier is matched by shape rather than as an arbitrary word.
const referencePatterns = (repo: string): ReadonlyArray<[UpstreamReferenceKind, RegExp]> => {
  const owner = escapeRegExp(repo);
  return [
    // GitHub repository identity is case-insensitive, so `PingDotGG/T3Code#4379`
    // reaches the same thread as the lowercase form and every pattern here is
    // matched without regard to case.
    ["issue", new RegExp(`(?<![\\w.\\-/])${owner}#\\d+`, "gi")],
    ["commit", new RegExp(`(?<![\\w.\\-/])${owner}@[0-9a-f]{7,40}\\b`, "gi")],
    [
      "url",
      new RegExp(
        `(?<![\\w.\\-@])(?:https?://)?(?:www\\.)?github\\.com/${owner}/` +
          `(?:(?:issues|pull|discussions)/\\d+|commit/[0-9a-f]{7,40})(?![\\w-])(?:#[\\w-]+)?`,
        "gi",
      ),
    ],
    // A number with no repository in front of it. GitHub tries this fork first
    // and falls through to `pingdotgg/t3code` when the fork has no such item,
    // which the guard cannot tell apart offline, so every bare number is a
    // finding. `GH-4379` is the same autolink spelled differently.
    ["number", /(?<![\w.\-/])(?:#|GH-)\d+/gi],
  ];
};

// Masking keeps every offset, so a finding's line and column still point at the
// original body. Newlines survive for the same reason. Every pass works in UTF-16
// code units, the unit `matchAll` reports an index in, so an astral character
// cannot shorten the masked copy and drag every later finding off its line.
const blank = (region: string) => region.replace(/[^\n]/g, " ");

const isBlank = (line: string) => /^[ \t]*$/.test(line);

// GitHub never renders an HTML comment, so it never links out of one. The
// landing tool's attestation footers live here and must not trip the guard. One
// that is never closed hides the rest of the body, so it is masked that far.
const maskHtmlComments = (body: string) => body.replace(/<!--[\s\S]*?-->|<!--[\s\S]*$/g, blank);

// A tab advances to the next four-column stop. Fork prose rarely indents with
// one, but counting it as a single column would misjudge a fence.
const indentWidth = (prefix: string) => {
  let width = 0;
  for (const character of prefix) width = character === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
};

// One `>` per blockquote level, each with up to three columns of indent and one
// space of padding. A quoted fence is still a fence.
const BLOCK_QUOTE = /^(?:[ \t]{0,3}>[ \t]?)+/;

// CommonMark gives a fence opener at most three columns of indent, measured from
// the content column of the innermost list item. A fourth column makes the line
// indented code: GitHub prints the backticks and leaves everything after them
// live prose, so treating it as an opener would mask a reference that still fires.
const FENCE_LINE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;

interface FenceLine {
  readonly indent: string;
  readonly marker: string;
  readonly info: string;
}

// The three groups are unconditional, so a match always carries all of them.
// Naming them once here keeps every later read a plain string, and a group that
// somehow went missing reads as "not a fence" rather than as an assertion.
const parseFenceLine = (line: string): FenceLine | undefined => {
  const match = FENCE_LINE.exec(line);
  if (match === null) return undefined;
  const [, indent, marker, info] = match;
  if (indent === undefined || marker === undefined || info === undefined) return undefined;
  return { indent, marker, info };
};

const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?=\S)/;

// A fence under a bullet sits past column four and is still a fence, so the
// budget above is measured from the content column the bullets on this line and
// the lines before it opened.
const consumeListMarkers = (line: string, column: number) => {
  let offset = 0;
  let content = column;
  for (;;) {
    const item = LIST_ITEM.exec(line.slice(offset));
    if (item === null) break;
    // The indent group is unconditional, so a match always carries it. Stopping
    // on an absent group keeps the offsets exact instead of assuming one.
    const indent = item[1];
    if (indent === undefined) break;
    if (indentWidth(line.slice(0, offset + indent.length)) > content + 3) break;
    offset += item[0].length;
    content = indentWidth(line.slice(0, offset));
  }
  return { content, offset };
};

// Only as many markers as the open fence sits behind. A line that quotes deeper
// than the fence keeps its extra `>` as fence content, so a longer run down
// there cannot close a fence that opened above it.
const stripQuoteMarkers = (line: string, depth: number) => {
  let offset = 0;
  for (let level = 0; level < depth; level += 1) {
    const marker = /^[ \t]{0,3}>[ \t]?/.exec(line.slice(offset));
    if (marker === null) return undefined;
    offset += marker[0].length;
  }
  return line.slice(offset);
};

// An unterminated fence swallows the rest of the body, which is what GitHub
// renders. A line that leaves the blockquote leaves the fence opened inside it.
// Indented code is masked here too: four columns past the innermost content
// column makes a line literal, so a citation in it links nothing and a backtick
// in it belongs to no code span.
const maskFencedBlocks = (body: string) => {
  let open: { readonly marker: string; readonly depth: number } | undefined;
  let listColumn = 0;
  let indented = false;
  let blankBefore = true;
  return body
    .split("\n")
    .map((line) => {
      const quote = BLOCK_QUOTE.exec(line)?.[0] ?? "";
      const depth = quote.match(/>/g)?.length ?? 0;
      if (open !== undefined && depth < open.depth) open = undefined;
      const outside = line.slice(quote.length);
      const rest = open === undefined ? outside : (stripQuoteMarkers(line, open.depth) ?? outside);

      if (open !== undefined) {
        const closer = parseFenceLine(rest);
        if (
          closer !== undefined &&
          closer.marker.startsWith(open.marker[0] ?? "") &&
          closer.marker.length >= open.marker.length &&
          closer.info.trim().length === 0 &&
          indentWidth(closer.indent) <= listColumn + 3
        ) {
          open = undefined;
        }
        indented = false;
        blankBefore = false;
        return blank(line);
      }

      // A blank line neither ends nor starts an indented code block; it is the
      // only thing that lets the next indented line start one.
      if (isBlank(rest)) {
        blankBefore = true;
        return line;
      }
      const { content, offset } = consumeListMarkers(rest, listColumn);
      const tail = rest.slice(offset);
      const fence = parseFenceLine(tail);
      const leading = fence?.indent ?? /^[ \t]*/.exec(tail)?.[0] ?? "";
      const indent = indentWidth(rest.slice(0, offset) + leading);
      // Indented code cannot interrupt a paragraph, so a wrapped line that
      // happens to sit four columns in stays prose.
      if (indent >= listColumn + 4 && (indented || blankBefore)) {
        indented = true;
        blankBefore = false;
        return blank(line);
      }
      indented = false;
      blankBefore = false;
      // A line that starts left of the open containers has closed them.
      listColumn = offset > 0 ? content : Math.min(listColumn, indent);
      if (fence === undefined || indent > listColumn + 3) return line;
      // A backtick fence cannot carry a backtick in its info string.
      if (fence.marker.startsWith("`") && fence.info.includes("`")) return line;
      open = { marker: fence.marker, depth };
      return blank(line);
    })
    .join("\n");
};

// A backtick is escaped when an odd number of backslashes runs up to it. The
// pairs cancel each other out, so `\\\\` is a literal backslash and the backtick
// after it is still a delimiter.
const isEscaped = (characters: ReadonlyArray<string>, index: number) => {
  let backslashes = 0;
  while (characters[index - 1 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
};

// A backtick run opens a code span and the next run of the same length closes it,
// so `` `pingdotgg/t3code#4379` `` masks even though it holds a backtick pair.
const maskSpansInBlock = (block: string) => {
  const characters = block.split("");
  let index = 0;
  while (index < characters.length) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }
    // An escaped backtick is literal text and opens nothing. CommonMark stops
    // honouring escapes once a span is open, so the closing scan below still
    // counts a run that a backslash runs into.
    if (isEscaped(characters, index)) {
      index += 1;
      continue;
    }
    let openEnd = index;
    while (characters[openEnd] === "`") openEnd += 1;
    const runLength = openEnd - index;
    let cursor = openEnd;
    let closeEnd = -1;
    while (cursor < characters.length) {
      if (characters[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let runEnd = cursor;
      while (characters[runEnd] === "`") runEnd += 1;
      if (runEnd - cursor === runLength) {
        closeEnd = runEnd;
        break;
      }
      cursor = runEnd;
    }
    if (closeEnd === -1) {
      index = openEnd;
      continue;
    }
    for (let position = index; position < closeEnd; position += 1) {
      if (characters[position] !== "\n") characters[position] = " ";
    }
    index = closeEnd;
  }
  return characters.join("");
};

const HEADING_LINE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;

// A setext underline ends the paragraph above it; a thematic break ends whatever
// ran into it. `---` is both, depending on what precedes it, and either reading
// puts a block boundary on the line.
const SETEXT_UNDERLINE = /^[ \t]{0,3}(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

// The CommonMark HTML blocks that may interrupt a paragraph: type 1 and the
// type 6 tag list. Type 7 is deliberately absent, because `<br>` or `<img src=x>`
// on a line of its own stays inside the paragraph around it and breaking there
// would report a citation GitHub still renders as code.
const HTML_BLOCK_TAGS =
  "pre script style textarea address article aside base basefont blockquote body caption center " +
  "col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame " +
  "frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav " +
  "noframes ol optgroup option p param search section summary table tbody td tfoot th thead " +
  "title tr track ul";

const HTML_BLOCK_LINE = new RegExp(
  `^[ \\t]{0,3}</?(?:${HTML_BLOCK_TAGS.replace(/ /g, "|")})(?:[ \\t>]|/>|$)`,
  "i",
);

const TABLE_DELIMITER = /^[ \t]{0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const quotePrefix = (line: string) => BLOCK_QUOTE.exec(line)?.[0] ?? "";

// A GFM table only starts where a delimiter row follows a header row that
// carries a pipe, so a stray `|` in prose is left alone.
const findTableLines = (lines: ReadonlyArray<string>) => {
  const rows = new Set<number>();
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    if (previous === undefined) return;
    const delimiter = line.slice(quotePrefix(line).length);
    const header = previous.slice(quotePrefix(previous).length);
    if (!delimiter.includes("|") || !TABLE_DELIMITER.test(delimiter)) return;
    if (isBlank(header) || !header.includes("|")) return;
    rows.add(index - 1).add(index);
    for (let row = index + 1; row < lines.length && !isBlank(lines[row] ?? ""); row += 1) {
      rows.add(row);
    }
  });
  return rows;
};

// Every cell is its own inline context, so a run in one cell never pairs with a
// run in the next. Splitting on the unescaped pipes and masking each piece keeps
// the line the same length, which is what the offsets depend on.
const maskTableRow = (line: string) => {
  // UTF-16 code units, the unit the scan below indexes in. Splitting by code
  // point would move the escape check off the backslash once an astral
  // character sits earlier in the row, and split the line at a pipe the cell
  // keeps.
  const characters = line.split("");
  const pieces: Array<string> = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|" || isEscaped(characters, index)) continue;
    pieces.push(maskSpansInBlock(line.slice(start, index)), "|");
    start = index + 1;
  }
  pieces.push(maskSpansInBlock(line.slice(start)));
  return pieces.join("");
};

// Code spans are inline, so a run only pairs with another run in the same block.
// Pairing them across a block boundary would mask a citation GitHub renders as
// ordinary prose, which is the direction that posts the backlink. Fenced and
// indented lines arrive here already blanked, so they split blocks too.
const maskCodeSpans = (body: string) => {
  const lines = body.split("\n");
  const tableRows = findTableLines(lines);
  const output: Array<string> = [];
  let block: Array<string> = [];
  // An HTML block holds raw HTML, where a backtick is a backtick. GitHub still
  // autolinks inside one, so its lines are emitted untouched rather than paired.
  let rawHtml = false;
  let quoteDepth = 0;
  const flush = () => {
    if (block.length > 0)
      output.push(rawHtml ? block.join("\n") : maskSpansInBlock(block.join("\n")));
    block = [];
    rawHtml = false;
  };
  lines.forEach((line, index) => {
    const quote = quotePrefix(line);
    const depth = quote.match(/>/g)?.length ?? 0;
    const rest = line.slice(quote.length);
    if (isBlank(rest)) {
      flush();
      quoteDepth = 0;
      output.push(line);
      return;
    }
    if (rawHtml) {
      block.push(line);
      return;
    }
    if (tableRows.has(index)) {
      flush();
      quoteDepth = depth;
      output.push(maskTableRow(line));
      return;
    }
    // A blockquote may interrupt a paragraph, but a paragraph that runs out of
    // one is a lazy continuation of it, so only a deeper quote is a boundary.
    if (depth > quoteDepth) flush();
    quoteDepth = depth;
    if (block.length > 0 && SETEXT_UNDERLINE.test(rest)) {
      block.push(line);
      flush();
      return;
    }
    if (THEMATIC_BREAK.test(rest)) {
      flush();
      output.push(line);
      return;
    }
    if (HTML_BLOCK_LINE.test(rest)) {
      flush();
      rawHtml = true;
      block.push(line);
      return;
    }
    // A heading is a block of its own on both sides, so a run in it pairs only
    // with another run in the same heading.
    if (HEADING_LINE.test(rest)) {
      flush();
      output.push(maskSpansInBlock(line));
      return;
    }
    if (LIST_ITEM.test(rest)) flush();
    block.push(line);
  });
  flush();
  return output.join("\n");
};

// Everything GitHub renders as code, blanked out at its original offsets.
export const maskMarkdownCode = (body: string): string =>
  maskCodeSpans(maskFencedBlocks(maskHtmlComments(body.replace(/\r\n/g, "\n"))));

const locate = (body: string, offset: number) => {
  const before = body.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastBreak };
};

// A bare `#107` is reported alongside the explicit forms. Whether it stays in
// the fork or falls through to upstream depends on numbers this guard cannot see
// offline, and the safe reading of an ambiguous citation is the one that assumes
// it reaches upstream.
export const findUpstreamReferences = (
  body: string,
  repo: string = UPSTREAM_REPO,
): ReadonlyArray<UpstreamReference> => {
  const normalized = body.replace(/\r\n/g, "\n");
  const masked = maskMarkdownCode(normalized);
  const found = referencePatterns(repo).flatMap(([kind, pattern]) =>
    [...masked.matchAll(pattern)].map((match) => ({
      kind,
      text: match[0],
      ...locate(normalized, match.index),
    })),
  );
  return found.toSorted((left, right) =>
    left.line === right.line ? left.column - right.column : left.line - right.line,
  );
};

export const renderReferences = (references: ReadonlyArray<UpstreamReference>): string =>
  references
    .map(
      (reference) =>
        `${reference.line}:${reference.column} ${reference.text} (${REFERENCE_LABELS[reference.kind]})\n`,
    )
    .join("");

const readStdin = Effect.promise(async () => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
});

const command = Command.make(
  "fork-upstream-refs",
  {
    bodyPath: Argument.string("body-path").pipe(
      Argument.withDescription(
        "Markdown body to scan: an issue, comment, or pull-request body. Reads stdin when absent.",
      ),
      Argument.optional,
    ),
  },
  ({ bodyPath }) =>
    Effect.gen(function* () {
      const source = Option.getOrElse(bodyPath, () => "stdin");
      const body = Option.isSome(bodyPath)
        ? yield* (yield* FileSystem.FileSystem).readFileString(bodyPath.value)
        : yield* readStdin;
      const references = findUpstreamReferences(body);
      if (references.length > 0) {
        process.stderr.write(renderReferences(references));
        process.stderr.write(
          `failed: ${references.length} live upstream reference(s) in ${source}; wrap each one in a code span or a fenced block so GitHub does not post a backlink on the ${UPSTREAM_REPO} thread, or write a bare number that names a fork item as ${FORK_REPO}#N, which renders the same (docs/internals/fork-development.md)\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`ok: no live upstream references in ${source}\n`);
    }),
).pipe(
  Command.withDescription(
    "Refuse a fork issue, comment, or pull-request body that cites an upstream item outside a code span or fenced block.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
