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
 * Each name's hue from its hash, bumped to the next free one on a clash, so up to six people
 * never share. Every client that sees the same names picks the same hues.
 */
export function peerHues(names: Iterable<string>): Map<string, number> {
  const hues = new Map<string, number>();
  const taken = new Set<number>();
  for (const name of [...new Set(names)].sort()) {
    let hash = 0;
    for (const char of name) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
    let hue = Math.abs(hash) % PEER_HUES;
    while (taken.has(hue) && taken.size < PEER_HUES) hue = (hue + 1) % PEER_HUES;
    taken.add(hue);
    hues.set(name, hue);
  }
  return hues;
}

const passageKey = ({ messageId, start, end }: AssistantCitation) => `${messageId}:${start}:${end}`;

const citesThread = (citation: AssistantCitation, threadRef: ScopedThreadRef) =>
  citation.threadId === threadRef.threadId && citation.environmentId === threadRef.environmentId;

const citationsIn = (text: string) =>
  text.includes("t3-citation:") ? collectAssistantCitations(text) : [];

const ownedPassage = (owner: string | null, citation: AssistantCitation) =>
  `${owner ?? ""}\u0000${passageKey(citation)}`;

type Unhued = Omit<Annotation, "hue">;

/**
 * Your draft's citations first, then others' live drafts, then sent ones. A passage someone
 * still drafts hides their sent copy; different people citing one passage each keep theirs.
 * `you` is your own name as the others see it, so everyone's hues agree.
 */
export function threadAnnotations(
  threadRef: ScopedThreadRef,
  draft: string,
  sent: ReadonlyArray<SentMessage>,
  peers: ReadonlyArray<PeerDraft>,
  you: string,
): Annotation[] {
  const drafts: Unhued[] = citationsIn(draft).flatMap(({ citation }, index) =>
    citesThread(citation, threadRef)
      ? [{ key: `draft:${index}`, citation, draftNumber: index + 1, owner: null }]
      : [],
  );
  const peerDrafts: Unhued[] = peers.flatMap((peer) =>
    peer.citations.flatMap((citation, index) =>
      citesThread(citation, threadRef)
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
  const sentAnnotations: Unhued[] = sent.flatMap((message) =>
    citationsIn(message.text).flatMap(({ citation }, index) =>
      citesThread(citation, threadRef) && !drafted.has(ownedPassage(message.owner, citation))
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
  const all = [...drafts, ...peerDrafts, ...sentAnnotations];
  const hues = peerHues(all.map(({ owner }) => owner ?? you));
  return all.map((annotation) => ({
    ...annotation,
    hue: annotation.owner === null ? null : hues.get(annotation.owner)!,
  }));
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
