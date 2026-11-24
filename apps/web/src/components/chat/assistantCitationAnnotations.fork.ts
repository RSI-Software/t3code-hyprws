import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";

export type Annotation = {
  key: string;
  citation: AssistantCitation;
  /** 1-based position among the draft's citations, matching the composer chip; null once sent. */
  draftNumber: number | null;
  /** Who cited it in a shared thread; null for you. */
  owner: string | null;
  /** The owner's colour; null for you. */
  hue: number | null;
};

/** Someone else's live draft in a shared thread, with this thread's citations. */
export type PeerDraft = {
  key: string;
  owner: string;
  citations: ReadonlyArray<AssistantCitation>;
};

export type SentMessage = { id: string; text: string; owner: string | null };

/** How many people a shared thread colours apart before hues repeat; matches the CSS. */
export const PEER_HUES = 6;

/**
 * Hues in the order people joined the thread, so a colour never moves while others start or stop
 * citing, and the first six never share. `people` is that order, the same on every client;
 * anyone else, such as someone whose share is gone, follows by name.
 */
export function peerHues(
  people: ReadonlyArray<string>,
  others: Iterable<string> = [],
): Map<string, number> {
  const joined = new Set(people);
  const rest = [...new Set(others)].filter((name) => !joined.has(name)).sort();
  return new Map([...joined, ...rest].map((name, index) => [name, index % PEER_HUES]));
}

const passageKey = ({ messageId, start, end }: AssistantCitation) => `${messageId}:${start}:${end}`;

const citesThread = (citation: AssistantCitation, threadRef: ScopedThreadRef) =>
  citation.threadId === threadRef.threadId && citation.environmentId === threadRef.environmentId;

const citationsIn = (text: string) =>
  text.includes("t3-citation:") ? collectAssistantCitations(text) : [];

// The host's key is "", so null (you) must stay distinct from it.
const ownedPassage = (owner: string | null, citation: AssistantCitation) =>
  JSON.stringify([owner, passageKey(citation)]);
const sameCite = (owner: string | null, citation: AssistantCitation) =>
  JSON.stringify([owner, passageKey(citation), citation.comment ?? null]);

type Unhued = Omit<Annotation, "hue">;

/**
 * Your draft's citations first, then others' live drafts, then sent and waiting ones. A passage
 * someone still drafts hides their sent copy; different people citing one passage each keep theirs.
 * `people` orders everyone's hues, as `peerHues` takes it.
 */
export function threadAnnotations(
  threadRef: ScopedThreadRef,
  draft: string,
  sent: ReadonlyArray<SentMessage>,
  waiting: ReadonlyArray<SentMessage>,
  peers: ReadonlyArray<PeerDraft>,
  people: ReadonlyArray<string>,
): Annotation[] {
  const drafts: Unhued[] = citationsIn(draft).flatMap(({ citation }, index) =>
    citesThread(citation, threadRef)
      ? [{ key: `draft:${index}`, citation, draftNumber: index + 1, owner: null }]
      : [],
  );
  // A reloaded page drafts anew while its old copy waits out the server's expiry; show one.
  const peerCites = new Set<string>();
  const firstCopy = (owner: string, citation: AssistantCitation) => {
    const cite = sameCite(owner, citation);
    if (peerCites.has(cite)) return false;
    peerCites.add(cite);
    return true;
  };
  const peerDrafts: Unhued[] = peers.flatMap((peer) =>
    peer.citations.flatMap((citation, index) =>
      citesThread(citation, threadRef) && firstCopy(peer.owner, citation)
        ? [
            {
              key: `peer:${peer.key}:${index}`,
              citation,
              draftNumber: index + 1,
              owner: peer.owner,
            },
          ]
        : [],
    ),
  );
  const drafted = new Set(
    [...drafts, ...peerDrafts].map(({ owner, citation }) => ownedPassage(owner, citation)),
  );
  const sentIn = (messages: ReadonlyArray<SentMessage>, skip: ReadonlySet<string>): Unhued[] =>
    messages.flatMap((message) =>
      citationsIn(message.text).flatMap(({ citation }, index) =>
        citesThread(citation, threadRef) &&
        !drafted.has(ownedPassage(message.owner, citation)) &&
        !skip.has(sameCite(message.owner, citation))
          ? [
              {
                key: `sent:${message.id}:${index}`,
                citation,
                draftNumber: null,
                owner: message.owner,
              },
            ]
          : [],
      ),
    );
  const sentCites = sentIn(sent, new Set());
  // A message the host just sent can still show as waiting; one copy is enough.
  const waitingCites = sentIn(
    waiting,
    new Set(sentCites.map(({ owner, citation }) => sameCite(owner, citation))),
  );
  const all = [...drafts, ...peerDrafts, ...sentCites, ...waitingCites];
  const hues = peerHues(
    people,
    all.flatMap(({ owner }) => (owner === null ? [] : [owner])),
  );
  return all.map((annotation) => ({
    ...annotation,
    hue: annotation.owner === null ? null : hues.get(annotation.owner)!,
  }));
}

/** A marker's size in rem, matching its `h-3.5` badge: padding, then one slot per glyph. */
const MARKER_PADDING = 0.875;
const MARKER_GLYPH = 0.375;
export const MARKER_HEIGHT = 0.875;
/** How far a marker reaches into its line's text box, which pads above the capitals. */
export const MARKER_LIFT = 0.25;
const MARKER_GAP = 0.125;

/** A marker's rough width in pixels at root font size `rem`: `❝` or an initial, then digits. */
export function markerWidth({ draftNumber }: Pick<Annotation, "draftNumber">, rem: number) {
  const digits = draftNumber === null ? 0 : String(draftNumber).length;
  return (MARKER_PADDING + MARKER_GLYPH * (1 + digits)) * rem;
}

/** Markers on one line keep their order but never overlap, and stay inside the lane. */
export function layOutMarkerLine(
  line: Array<{ left: number; width: number }>,
  laneWidth: number,
  rem: number,
) {
  line.sort((a, b) => a.left - b.left);
  let cursor = Number.NEGATIVE_INFINITY;
  for (const marker of line) {
    marker.left = Math.max(marker.left, cursor + MARKER_GAP * rem);
    cursor = marker.left + marker.width;
  }
  const overflow = cursor - laneWidth;
  if (overflow > 0) {
    const shift = Math.min(overflow, line[0]!.left);
    for (const marker of line) marker.left -= shift;
  }
}

/**
 * When each marker's pop ends, by each person's draft or sent occurrence of its passage: citing a
 * passage again pops the new marker, even over its sent copy, while a draft turning into its sent
 * copy stays still. Without `previous` nothing pops; gone occurrences are dropped.
 */
export function markerPops(
  previous: ReadonlyMap<string, number> | undefined,
  annotations: ReadonlyArray<Pick<Annotation, "key" | "citation" | "owner" | "draftNumber">>,
  until: number,
) {
  const occurrences = new Map<string, number>();
  const ends = new Map<string, number>();
  const byKey = new Map<string, number>();
  for (const { key, citation, owner, draftNumber } of annotations) {
    const passage = ownedPassage(owner, citation);
    const occurrence = (occurrences.get(passage) ?? 0) + 1;
    occurrences.set(passage, occurrence);
    const drafted = draftNumber !== null;
    const id = `${drafted ? "draft" : "sent"}:${passage}#${occurrence}`;
    const sentFromDraft = drafted ? undefined : previous?.get(`draft:${passage}#1`);
    const end = previous ? (previous.get(id) ?? sentFromDraft ?? until) : 0;
    ends.set(id, end);
    byKey.set(key, end);
  }
  return { ends, byKey };
}

/** The draft with its `draftNumber`th citation's comment replaced, or null when it is gone. */
export function withDraftCitationComment(
  draft: string,
  draftNumber: number,
  comment: string,
): string | null {
  const target = citationsIn(draft)[draftNumber - 1];
  if (!target) return null;
  const next = serializeAssistantCitation(withAssistantCitationComment(target.citation, comment));
  return draft.slice(0, target.start) + next + draft.slice(target.end);
}

/** The draft without its `draftNumber`th citation, or null when it is gone. */
export function withoutDraftCitation(draft: string, draftNumber: number): string | null {
  const target = citationsIn(draft)[draftNumber - 1];
  if (!target) return null;
  const before = draft.slice(0, target.start);
  const after = draft.slice(target.end);
  // Drop one separating space so removal leaves no double gap.
  return before.endsWith(" ") || before === "" ? before + after.replace(/^ /, "") : before + after;
}
