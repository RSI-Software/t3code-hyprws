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

/** The same name gets the same hue on every client. */
export function peerHue(owner: string): number {
  let hash = 0;
  for (const char of owner) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % PEER_HUES;
}

const passageKey = ({ messageId, start, end }: AssistantCitation) => `${messageId}:${start}:${end}`;

const citesThread = (citation: AssistantCitation, threadRef: ScopedThreadRef) =>
  citation.threadId === threadRef.threadId && citation.environmentId === threadRef.environmentId;

const citationsIn = (text: string) =>
  text.includes("t3-citation:") ? collectAssistantCitations(text) : [];

const ownedPassage = (owner: string | null, citation: AssistantCitation) =>
  `${owner ?? ""}\u0000${passageKey(citation)}`;

/**
 * Your draft's citations first, then others' live drafts, then sent ones. A passage someone
 * still drafts hides their sent copy; different people citing one passage each keep theirs.
 */
export function threadAnnotations(
  threadRef: ScopedThreadRef,
  draft: string,
  sent: ReadonlyArray<SentMessage>,
  peers: ReadonlyArray<PeerDraft> = [],
): Annotation[] {
  const drafts: Annotation[] = citationsIn(draft).flatMap(({ citation }, index) =>
    citesThread(citation, threadRef)
      ? [{ key: `draft:${index}`, citation, draftNumber: index + 1, owner: null }]
      : [],
  );
  const peerDrafts: Annotation[] = peers.flatMap((peer) =>
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
  const sentAnnotations: Annotation[] = sent.flatMap((message) =>
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
  return [...drafts, ...peerDrafts, ...sentAnnotations];
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
