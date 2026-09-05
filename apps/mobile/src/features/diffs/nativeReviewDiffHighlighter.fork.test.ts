import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { NativeReviewDiffRow } from "./nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "./nativeReviewDiffTypes";
import {
  highlightNativeReviewDiffVisibleRows,
  type NativeReviewDiffHighlightEngine,
} from "./nativeReviewDiffHighlighter";

const tokenization = vi.hoisted(() => ({
  timeLimits: [] as Array<number | undefined>,
}));

vi.mock("@shikijs/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shikijs/core")>();
  return {
    ...original,
    createHighlighterCore: async (...args: Parameters<typeof original.createHighlighterCore>) => {
      const highlighter = await original.createHighlighterCore(...args);
      return {
        ...highlighter,
        codeToTokensBase: (...input: Parameters<typeof highlighter.codeToTokensBase>) => {
          tokenization.timeLimits.push(input[1]?.tokenizeTimeLimit);
          return highlighter.codeToTokensBase(...input);
        },
      };
    },
  };
});

vi.mock("react-native-shiki-engine", async () => {
  const { createJavaScriptRegexEngine } = await import("@shikijs/engine-javascript");
  return { isNativeEngineAvailable: () => true, createNativeEngine: createJavaScriptRegexEngine };
});

afterEach(() => {
  tokenization.timeLimits = [];
});

const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 3,
  deletions: 0,
};

function makeLine(id: string, content: string, newLineNumber: number): NativeReviewDiffRow {
  return {
    kind: "line",
    id,
    fileId: TYPESCRIPT_FILE.id,
    content,
    change: "add",
    oldLineNumber: null,
    newLineNumber,
  };
}

function highlight(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  engine: NativeReviewDiffHighlightEngine,
) {
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    engine,
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
  });
}

describe.each(["native", "javascript"] as const)("%s grammar tokenization", (engine) => {
  it("finishes multiline syntax across inline comment rows without a time cutoff", async () => {
    const opening = makeLine("template-open", "const message = `open", 1);
    const closing = makeLine("template-close", "closed`;", 2);
    const trailing = makeLine("trailing-row", "export const answer = 42;", 3);
    const comment: NativeReviewDiffRow = {
      kind: "comment",
      id: "comment-1",
      fileId: TYPESCRIPT_FILE.id,
      commentText: "Review note",
    };

    const [withComment, contiguous] = await Promise.all([
      highlight([opening, comment, closing, trailing], engine),
      highlight([opening, closing, trailing], engine),
    ]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
    expect(tokenization.timeLimits).toEqual([0, 0]);
  });
});
