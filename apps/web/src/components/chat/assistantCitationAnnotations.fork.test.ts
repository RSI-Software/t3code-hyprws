import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  markerPops,
  type PeerDraft,
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
      [""],
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
        // Alex's page before a reload, until the server forgets it.
        { key: "alex-old", owner: "Alex", citations: [citation(shared, 40)] },
      ],
      ["", "Jordan", "Alex"],
    );
    // Sam's share is gone, so Sam follows everyone who joined.
    expect(
      annotations.map(({ key, owner, draftNumber, hue }) => [key, owner, draftNumber, hue]),
    ).toEqual([
      ["draft:0", null, 1, null],
      ["peer:alex:0", "Alex", 1, 2],
      ["sent:sent-sam:0", "Sam", null, 3],
    ]);
  });

  it("keeps your sent citation when the host drafts the same passage", () => {
    const annotations = threadAnnotations(
      threadRef,
      "",
      [{ id: "sent-1", text: second, owner: null }],
      [],
      [{ key: "host", owner: "", citations: [citation("Asks before it writes", 40)] }],
      ["", "Alex"],
    );
    expect(annotations.map(({ key, owner }) => [key, owner])).toEqual([
      ["peer:host:0", ""],
      ["sent:sent-1:0", null],
    ]);
  });

  it("keeps Jordan's hue when Alex starts citing", () => {
    const people = ["", "Alex", "Jordan"];
    const jordan = { key: "jordan", owner: "Jordan", citations: [citation("Reads", 10)] };
    const alex = { key: "alex", owner: "Alex", citations: [citation("Asks", 40)] };
    const hues = (peers: PeerDraft[]) =>
      threadAnnotations(threadRef, "", [], [], peers, people).map(({ owner, hue }) => [owner, hue]);
    expect(hues([jordan])).toEqual([["Jordan", 2]]);
    expect(hues([jordan, alex])).toEqual([
      ["Jordan", 2],
      ["Alex", 1],
    ]);
  });

  it("shows a waiting cite once when its sent copy has arrived", () => {
    const annotations = threadAnnotations(
      threadRef,
      "",
      [{ id: "sent-1", text: first, owner: "Alex" }],
      [
        { id: "waiting:1", text: first, owner: "Alex" },
        { id: "waiting:2", text: second, owner: "Alex" },
      ],
      [],
      ["", "Alex"],
    );
    expect(annotations.map(({ key }) => key)).toEqual(["sent:sent-1:0", "sent:waiting:2:0"]);
  });
});

describe("peerHues", () => {
  it("colours people in the order they joined, then anyone else by name", () => {
    const hues = { "": 0, Jordan: 1, Alex: 2, Morgan: 3, Sam: 4 };
    expect(Object.fromEntries(peerHues(["", "Jordan", "Alex"], ["Sam", "Morgan", "Alex"]))).toEqual(
      hues,
    );
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

describe("markers", () => {
  it("pops a passage cited again or re-cited, but not a draft turning into its sent copy", () => {
    const annotations = (draft: string, sent = "", peers: PeerDraft[] = []) =>
      threadAnnotations(
        threadRef,
        draft,
        sent ? [{ id: "sent-1", text: sent, owner: null }] : [],
        [],
        peers,
        ["", "Alex"],
      );
    const pops = (
      previous: ReadonlyMap<string, number> | undefined,
      list: ReturnType<typeof annotations>,
      until: number,
    ) => {
      const next = markerPops(previous, list, until);
      return { ends: next.ends, at: list.map(({ key }) => next.byKey.get(key)) };
    };
    const opened = pops(undefined, annotations(second), 100);
    expect(opened.at).toEqual([0]);
    const twice = pops(opened.ends, annotations(`${second} ${second}`), 200);
    expect(twice.at).toEqual([0, 200]);
    const sent = pops(twice.ends, annotations("", second), 300);
    expect(sent.at).toEqual([0]);
    expect(pops(sent.ends, annotations(second, second), 400).at).toEqual([400]);
    // Citing what a peer already cites pops yours, and leaves theirs still.
    const alex = [
      { key: "alex", owner: "Alex", citations: [citation("Asks before it writes", 40)] },
    ];
    const peer = pops(opened.ends, annotations("", "", alex), 300);
    expect(pops(peer.ends, annotations(second, "", alex), 400).at).toEqual([400, 300]);
    const removed = pops(twice.ends, annotations(""), 300);
    expect(pops(removed.ends, annotations(second), 400).at).toEqual([400]);
  });
});
