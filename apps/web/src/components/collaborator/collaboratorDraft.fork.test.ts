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

const threadId = ThreadId.make("thread");
const citation = (thread: string, text: string) => ({
  version: 1 as const,
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(thread),
  messageId: MessageId.make("m1"),
  text,
  start: 0,
  end: text.length,
  prefix: "",
  suffix: "",
});

describe("collaboratorDraftFork", () => {
  it("shows nothing for an empty draft", () => {
    expect(collaboratorDraftFork(null, threadId)).toBeNull();
    expect(collaboratorDraftFork({ ...empty, prompt: "  \n" }, threadId)).toBeNull();
  });

  it("reads contexts as labels and chips, never their bodies", () => {
    const quoted = citation("thread", "the quoted reply");
    const elsewhere = serializeAssistantCitation(citation("other", "another thread"));
    const reviewReference = {
      kind: "review-comment",
      contextId: reviewCommentContextId(comment.id),
      label: reviewCommentContextLabel(comment),
    };
    const draft = collaboratorDraftFork(
      {
        ...empty,
        prompt: `Look at ${formatComposerContextReference(reviewReference)} and ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${serializeAssistantCitation(quoted)}${elsewhere}`,
        reviewComments: [comment],
        terminalContexts: [terminal],
      },
      threadId,
    );
    expect(draft?.text).toBe(`Look at app.ts L12 and “the quoted reply”“another thread”`);
    expect(draft?.chips.map(({ kind }) => kind)).toEqual([
      "terminal",
      "review-comment",
      "citation",
      "citation",
    ]);
    // Only this thread's citations travel whole, so others can mark them inline.
    expect(draft?.citations).toEqual([quoted]);
    expect(JSON.stringify(draft)).not.toMatch(/SECRET/);
  });

  it("keeps the end of a draft past the cap", () => {
    const draft = collaboratorDraftFork(
      { ...empty, prompt: `start ${"x".repeat(COLLABORATOR_DRAFT_TEXT_MAX_CHARS)} end` },
      threadId,
    );
    expect(draft?.truncated).toBe(true);
    expect(draft?.text).toHaveLength(COLLABORATOR_DRAFT_TEXT_MAX_CHARS);
    expect(draft?.text.endsWith(" end")).toBe(true);
  });
});
