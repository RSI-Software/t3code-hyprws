import {
  COLLABORATOR_DRAFT_TEXT_MAX_CHARS,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { decodeMsg } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import { reviewCommentContextId, reviewCommentContextLabel } from "~/lib/composerContextRecords";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "~/lib/terminalContext";
import type { MessageResolver } from "~/i18n/messages";
import {
  collaboratorDraftFork,
  draftChipLabelFork,
  draftTextFork,
  withinActive,
} from "./collaboratorDraft.fork";

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
    // This thread's citation shows on its passage, never in the text or as a chip.
    expect(draft?.text).toBe("Look at app.ts L12 and");
    expect(draft?.chips.map(({ kind, label }) => [kind, label])).toEqual([
      ["terminal", "Terminal 1 lines 1-2"],
      ["review-comment", "app.ts L12"],
      ["citation", "another thread"],
    ]);
    expect(draft?.citations).toEqual([quoted]);
    expect(JSON.stringify(draft)).not.toMatch(/SECRET/);
  });

  it("keeps this thread's citations marked however long the draft sits idle", () => {
    const quoted = citation("thread", "the quoted reply");
    const citedOnly = { text: "", truncated: false, chips: [], citations: [quoted] };
    const cited = serializeAssistantCitation(quoted);
    expect(collaboratorDraftFork({ ...empty, prompt: ` ${cited} ` }, threadId)).toEqual(citedOnly);
    const writing = collaboratorDraftFork({ ...empty, prompt: `${cited} why?` }, threadId);
    expect(withinActive(writing, 29_000)).toBe(writing);
    // Idle, the text stops showing but the citations keep marking their passages.
    expect(withinActive(writing, 31_000)).toEqual(citedOnly);
    expect(
      withinActive(collaboratorDraftFork({ ...empty, prompt: "why?" }, threadId), 31_000),
    ).toBeNull();
  });

  const german = ((message: string) => `de:${decodeMsg(message)}`) as MessageResolver;
  const range = { ...comment, id: "c2", rangeLabel: "+12 to +15" };
  const inline = formatComposerContextReference({
    kind: "review-comment",
    contextId: reviewCommentContextId(range.id),
    label: reviewCommentContextLabel(range),
  });

  it("shows the generated parts of chip labels in the viewer's language", () => {
    const draft = collaboratorDraftFork(
      {
        ...empty,
        prompt: `  Look at ${inline}, not my app.ts L12 to L15`,
        reviewComments: [range, { ...comment, id: "c3", rangeLabel: "-3" }, comment],
        previewAnnotations: [
          { id: "p1", comment: "", pageTitle: "" },
          { id: "p2", comment: "Make it blue", pageTitle: "" },
        ] as never,
      },
      threadId,
    );
    expect(draft?.chips.map((chip) => draftChipLabelFork(chip, german))).toEqual([
      "app.ts de:L12 to L15",
      "app.ts de:L3 (before)",
      "app.ts L12",
      "de:Preview annotation",
      "Make it blue",
    ]);
    // Only the reference is generated; the same words typed by its author stay as written.
    expect(draft && draftTextFork(draft, german)).toBe(
      "Look at app.ts de:L12 to L15, not my app.ts L12 to L15",
    );
  });

  it("keeps the end of a draft past the cap", () => {
    const draft = collaboratorDraftFork(
      {
        ...empty,
        prompt: `${inline} ${"x".repeat(COLLABORATOR_DRAFT_TEXT_MAX_CHARS)} ${inline} end`,
        reviewComments: [range],
      },
      threadId,
    );
    expect(draft?.truncated).toBe(true);
    expect(draft?.text).toHaveLength(COLLABORATOR_DRAFT_TEXT_MAX_CHARS);
    expect(draft && draftTextFork(draft, german).endsWith(" app.ts de:L12 to L15 end")).toBe(true);
  });
});
