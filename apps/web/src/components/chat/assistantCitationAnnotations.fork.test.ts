import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  peerHues,
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
    const annotations = threadAnnotations(
      threadRef,
      `${elsewhere} ${first} and ${second}`,
      [{ id: "sent-1", text: `${second} ${cite("Streams a terminal result", 70)}`, owner: null }],
      [],
      [],
      "",
    );
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
      [],
      [
        {
          key: "alex",
          owner: "Alex",
          citations: [citation(shared, 40), citation("x", 0, { threadId: ThreadId.make("other") })],
        },
      ],
      "Jordan",
    );
    // Jordan's own name joins the hue choice: Alex keeps its hash's hue, so Jordan moves on.
    expect(
      annotations.map(({ key, owner, draftNumber, hue }) => [key, owner, draftNumber, hue]),
    ).toEqual([
      ["draft:0", null, 1, null],
      ["peer:alex:0", "Alex", 1, 4],
      ["sent:sent-sam:0", "Sam", null, 1],
    ]);
  });

  it("keeps everyone's hue when a waiting message only the host sees joins", () => {
    const annotations = threadAnnotations(
      threadRef,
      "",
      [],
      [{ id: "waiting:1", text: second, owner: "Alex" }],
      [{ key: "jordan", owner: "Jordan", citations: [citation("Reads the manifest first", 10)] }],
      "",
    );
    // Jordan keeps the hue every other client gives them; Alex, hashing alike, moves on.
    expect(annotations.map(({ owner, hue }) => [owner, hue])).toEqual([
      ["Jordan", 4],
      ["Alex", 5],
    ]);
  });
});

describe("peerHues", () => {
  it("gives up to six names distinct hues, the same whatever order they arrive in", () => {
    const hues = { Alex: 4, Host: 0, Jordan: 5, Morgan: 1 };
    expect(Object.fromEntries(peerHues(["Morgan", "Jordan", "Host", "Alex"]))).toEqual(hues);
    expect(Object.fromEntries(peerHues(["Alex", "Host", "Morgan", "Jordan"]))).toEqual(hues);
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
