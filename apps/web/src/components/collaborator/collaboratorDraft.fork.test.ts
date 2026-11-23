import {
  COLLABORATOR_DRAFT_TEXT_MAX_CHARS,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { reviewCommentContextId, reviewCommentContextLabel } from "~/lib/composerContextRecords";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "~/lib/terminalContext";
import { collaboratorDraftFork } from "./collaboratorDraft.fork";

const empty = {
  prompt: "",
  images: [],
  files: [],
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [],
  threadContexts: [],
  environmentContexts: [],
  replyTo: null,
};
const comment = {
  id: "c1",
  sectionId: "working-tree",
  sectionTitle: "Working tree",
  filePath: "src/app.ts",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "+12",
  text: "Rename this",
  diff: "SECRET-DIFF-BODY",
};
const terminal = {
  id: "t1",
  threadId: ThreadId.make("thread"),
  createdAt: "2026-11-23T00:00:00.000Z",
  terminalId: "term",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 2,
  text: "SECRET-TERMINAL-TEXT",
};

describe("collaboratorDraftFork", () => {
  it("shows nothing for an empty draft", () => {
    expect(collaboratorDraftFork(null)).toBeNull();
    expect(collaboratorDraftFork({ ...empty, prompt: "  \n" })).toBeNull();
  });

  it("reads contexts as labels and chips, never their bodies", () => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("m1"),
      text: "the quoted reply",
      start: 0,
      end: 16,
      prefix: "",
      suffix: "",
    });
    const reviewReference = {
      kind: "review-comment",
      contextId: reviewCommentContextId(comment.id),
      label: reviewCommentContextLabel(comment),
    };
    const draft = collaboratorDraftFork({
      ...empty,
      prompt: `Look at ${formatComposerContextReference(reviewReference)} and ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${quote}`,
      reviewComments: [comment],
      terminalContexts: [terminal],
    });
    expect(draft?.text).toBe(`Look at app.ts L12 and “the quoted reply”`);
    expect(draft?.chips.map(({ kind }) => kind)).toEqual([
      "terminal",
      "review-comment",
      "citation",
    ]);
    expect(JSON.stringify(draft)).not.toMatch(/SECRET/);
  });

  it("keeps the end of a draft past the cap", () => {
    const draft = collaboratorDraftFork({
      ...empty,
      prompt: `start ${"x".repeat(COLLABORATOR_DRAFT_TEXT_MAX_CHARS)} end`,
    });
    expect(draft?.truncated).toBe(true);
    expect(draft?.text).toHaveLength(COLLABORATOR_DRAFT_TEXT_MAX_CHARS);
    expect(draft?.text.endsWith(" end")).toBe(true);
  });
});
