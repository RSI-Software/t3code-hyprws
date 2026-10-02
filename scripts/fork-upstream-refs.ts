#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone body check runs before an Effect runtime exists.
// Refuses fork prose citing an upstream item outside a code span or fence: a
// live `pingdotgg/t3code#4379` or item URL posts a backlink on the upstream
// thread from the fork's bot account, and a bare `#4379` falls through there when the fork holds no such number. Run pre-publish; nothing un-posts one.

import * as NodeFS from "node:fs";
import { FORK_REPOSITORY, UPSTREAM_REPOSITORY } from "./lib/fork-policy.ts";

export const UPSTREAM_REPO = UPSTREAM_REPOSITORY;
export const FORK_REPO = FORK_REPOSITORY;

const REFERENCE_LABELS = {
  issue: "cross-repo issue reference",
  commit: "cross-repo commit reference",
  url: "upstream item URL",
  number: "bare item number, resolved upstream when this fork has no such item",
} as const;

export interface UpstreamReference {
  readonly kind: keyof typeof REFERENCE_LABELS;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

// The one regex: every form GitHub turns into an event on an upstream item,
// case-insensitive because repository identity is. The lookbehinds keep a full
// fork citation (`RSI-Software/t3code-hyprws#108`) out of the bare-number arm.
const UPSTREAM_REFERENCE = new RegExp(
  [
    "(?<![\\w.\\-/])pingdotgg/t3code#\\d+",
    "(?<![\\w.\\-/])pingdotgg/t3code@[0-9a-f]{7,40}\\b",
    "(?<![\\w.\\-@])(?:https?://)?(?:www\\.)?github\\.com/pingdotgg/t3code/" +
      "(?:(?:issues|pull|discussions)/\\d+|commit/[0-9a-f]{7,40})(?![\\w-])(?:#[\\w-]+)?",
    "(?<![\\w.\\-/])(?:#|GH-)\\d+",
  ].join("|"),
  "gi",
);

const kindOf = (text: string): UpstreamReference["kind"] => {
  if (/github\.com\//i.test(text)) return "url";
  if (/^pingdotgg\/t3code@/i.test(text)) return "commit";
  if (/^pingdotgg\/t3code#/i.test(text)) return "issue";
  return "number";
};

// Masking blanks every region GitHub renders as code — it never links from one
// — keeping offsets and newlines, so a finding's line and column still point at
// the original body. An HTML comment renders as nothing, so the pull-request
// template's instructions and the landing tool's attestation footers live in
// one safely; one never closed hides the rest of the body, as on GitHub.
const maskHtmlComments = (body: string) =>
  body.replace(/<!--[\s\S]*?-->|<!--[\s\S]*$/g, (region) => region.replace(/[^\n]/g, " "));

// A fence is up to three spaces of indent then three or more backticks or
// tildes; an equal-or-longer run of the same character with no info text closes
// it, an unterminated one swallows the rest of the body, as on GitHub.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const maskFencedBlocks = (body: string) => {
  let open: string | undefined;
  return body
    .split("\n")
    .map((line) => {
      const [, marker = "", info = ""] = FENCE.exec(line) ?? [];
      if (open !== undefined) {
        if (marker[0] === open[0] && marker.length >= open.length && info.trim() === "")
          open = undefined;
        return line.replace(/[^\n]/g, " ");
      }
      if (marker.length === 0 || (marker.startsWith("`") && info.includes("`"))) return line;
      open = marker;
      return line.replace(/[^\n]/g, " ");
    })
    .join("\n");
};

// A backtick run opens a code span and the next run of the same length on the
// same line closes it, so `` `pingdotgg/t3code#4379` `` masks despite its pair;
// a backtick behind an odd backslash run is literal and opens nothing.
const maskCodeSpans = (body: string) =>
  body
    .split("\n")
    .map((line) => {
      const characters = line.split("");
      let open: { readonly start: number; readonly length: number } | undefined;
      for (const run of line.matchAll(/`+/g)) {
        const [start, length] = [run.index ?? 0, run[0].length];
        if (open === undefined) {
          if ((/\\*$/.exec(line.slice(0, start))?.[0].length ?? 0) % 2 === 0)
            open = { start, length };
          continue;
        }
        if (length === open.length) {
          for (let position = open.start; position < start + length; position += 1)
            characters[position] = " ";
          open = undefined;
        }
      }
      return characters.join("");
    })
    .join("\n");

export const findUpstreamReferences = (body: string): ReadonlyArray<UpstreamReference> => {
  const normalized = body.replace(/\r\n/g, "\n");
  const masked = maskCodeSpans(maskFencedBlocks(maskHtmlComments(normalized)));
  return [...masked.matchAll(UPSTREAM_REFERENCE)]
    .map((match) => {
      const before = normalized.slice(0, match.index);
      return {
        kind: kindOf(match[0]),
        text: match[0],
        line: before.split("\n").length,
        column: match.index - before.lastIndexOf("\n"),
      };
    })
    .toSorted((left, right) => left.line - right.line || left.column - right.column);
};

export const renderReferences = (references: ReadonlyArray<UpstreamReference>): string =>
  references
    .map(
      ({ kind, line, column, text }) => `${line}:${column} ${text} (${REFERENCE_LABELS[kind]})\n`,
    )
    .join("");

interface CheckResult {
  readonly ok: boolean;
  readonly unreadable: boolean;
  readonly references: number;
}

const check = (source: string): CheckResult => {
  let body: string;
  try {
    body = NodeFS.readFileSync(source, "utf8");
  } catch (error) {
    process.stderr.write(
      `failed: cannot read ${source}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { ok: false, unreadable: true, references: 0 };
  }
  const references = findUpstreamReferences(body);
  if (references.length === 0) {
    process.stdout.write(`ok: no live upstream references in ${source}\n`);
    return { ok: true, unreadable: false, references: 0 };
  }
  process.stderr.write(renderReferences(references));
  process.stderr.write(
    `failed: ${references.length} live upstream reference(s) in ${source}; wrap each one in a code span or a fenced block so GitHub does not post a backlink on the ${UPSTREAM_REPO} thread, or write a bare number that names a fork item as ${FORK_REPO}#N, which renders the same (docs/fork/internals/fork-development.md)\n`,
  );
  return { ok: false, unreadable: false, references: references.length };
};

const run = (argv: ReadonlyArray<string>): number => {
  if (argv.length === 0) {
    process.stderr.write("failed: no input files; pass at least one body file to check\n");
    return 1;
  }
  let failedFiles = 0;
  let unreadableFiles = 0;
  let totalReferences = 0;
  for (const source of argv) {
    const { ok, unreadable, references } = check(source);
    if (!ok) failedFiles += 1;
    if (unreadable) unreadableFiles += 1;
    totalReferences += references;
  }
  if (argv.length === 1) return failedFiles > 0 ? 1 : 0;
  if (failedFiles > 0) {
    const parts: string[] = [];
    if (totalReferences > 0) parts.push(`${totalReferences} live upstream reference(s)`);
    if (unreadableFiles > 0) parts.push(`${unreadableFiles} unreadable file(s)`);
    process.stderr.write(
      `failed: ${parts.join(" and ")} in ${failedFiles} of ${argv.length} file(s)\n`,
    );
    return 1;
  }
  process.stdout.write(`ok: no live upstream references in ${argv.length} file(s)\n`);
  return 0;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
