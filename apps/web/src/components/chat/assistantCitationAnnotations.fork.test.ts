import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  threadAnnotations,
  withDraftCitationComment,
  withoutDraftCitation,
} from "./assistantCitationAnnotations.fork";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const cite = (text: string, start: number, extra: Partial<AssistantCitation> = {}) =>
  serializeAssistantCitation({
    version: 1,
    ...threadRef,
    messageId: MessageId.make("answer"),
    text,
    start,
    end: start + text.length,
    prefix: "",
    suffix: "",
    ...extra,
  });

const elsewhere = cite("other thread", 0, { threadId: ThreadId.make("other") });
const first = cite("Reads the manifest first", 10, { comment: "why first?" });
const second = cite("Asks before it writes", 40);

describe("threadAnnotations", () => {
  it("numbers draft citations by draft position and drops sent duplicates", () => {
    const annotations = threadAnnotations(threadRef, `${elsewhere} ${first} and ${second}`, [
      { id: "sent-1", text: `${second} ${cite("Streams a terminal result", 70)}` },
    ]);
    expect(annotations.map(({ citation, draftNumber }) => [citation.text, draftNumber])).toEqual([
      ["Reads the manifest first", 2],
      ["Asks before it writes", 3],
      ["Streams a terminal result", null],
    ]);
  });
});

describe("draft citation edits", () => {
  const draft = `Look at ${first} and ${second} please`;

  it("rewrites only the numbered citation's comment", () => {
    const next = withDraftCitationComment(draft, 2, "  once per session?  ")!;
    expect(collectAssistantCitations(next).map(({ citation }) => citation.comment)).toEqual([
      "why first?",
      "once per session?",
    ]);
    expect(next.startsWith("Look at ") && next.endsWith(" please")).toBe(true);
    const cleared = withDraftCitationComment(next, 1, " ")!;
    expect(collectAssistantCitations(cleared)[0]!.citation.comment).toBeUndefined();
  });

  it("removes a citation without leaving a double space", () => {
    expect(withoutDraftCitation(draft, 1)).toBe(`Look at and ${second} please`);
    expect(withoutDraftCitation(`${first} tail`, 1)).toBe("tail");
    expect(withoutDraftCitation(draft, 3)).toBeNull();
  });
});
