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

const citation = (
  text: string,
  start: number,
  extra: Partial<AssistantCitation> = {},
): AssistantCitation => ({
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
const cite = (text: string, start: number, extra: Partial<AssistantCitation> = {}) =>
  serializeAssistantCitation(citation(text, start, extra));

const elsewhere = cite("other thread", 0, { threadId: ThreadId.make("other") });
const first = cite("Reads the manifest first", 10, { comment: "why first?" });
const second = cite("Asks before it writes", 40);

describe("threadAnnotations", () => {
  it("numbers draft citations by draft position and drops sent duplicates", () => {
    const annotations = threadAnnotations(threadRef, `${elsewhere} ${first} and ${second}`, [
      { id: "sent-1", text: `${second} ${cite("Streams a terminal result", 70)}`, owner: null },
    ]);
    expect(annotations.map(({ citation, draftNumber }) => [citation.text, draftNumber])).toEqual([
      ["Reads the manifest first", 2],
      ["Asks before it writes", 3],
      ["Streams a terminal result", null],
    ]);
  });

  it("keeps each person's citation of a shared passage, hiding only their own sent copy", () => {
    const shared = "Asks before it writes";
    const annotations = threadAnnotations(
      threadRef,
      second,
      [
        { id: "sent-alex", text: second, owner: "Alex" },
        { id: "sent-sam", text: second, owner: "Sam" },
      ],
      [
        {
          key: "alex",
          owner: "Alex",
          citations: [citation(shared, 40), citation("x", 0, { threadId: ThreadId.make("other") })],
        },
      ],
    );
    expect(annotations.map(({ key, owner, draftNumber }) => [key, owner, draftNumber])).toEqual([
      ["draft:0", null, 1],
      ["peer:alex:0", "Alex", 1],
      ["sent:sent-sam:0", "Sam", null],
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
