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
};

const passageKey = ({ messageId, start, end }: AssistantCitation) => `${messageId}:${start}:${end}`;

const citesThread = (citation: AssistantCitation, threadRef: ScopedThreadRef) =>
  citation.threadId === threadRef.threadId && citation.environmentId === threadRef.environmentId;

const citationsIn = (text: string) =>
  text.includes("t3-citation:") ? collectAssistantCitations(text) : [];

/** Draft citations first, then sent ones; a passage cited in both shows as the draft. */
export function threadAnnotations(
  threadRef: ScopedThreadRef,
  draft: string,
  sent: ReadonlyArray<{ id: string; text: string }>,
): Annotation[] {
  const drafts = citationsIn(draft).flatMap(({ citation }, index) =>
    citesThread(citation, threadRef)
      ? [{ key: `draft:${index}`, citation, draftNumber: index + 1 }]
      : [],
  );
  const drafted = new Set(drafts.map(({ citation }) => passageKey(citation)));
  const sentAnnotations = sent.flatMap((message) =>
    citationsIn(message.text).flatMap(({ citation }, index) =>
      citesThread(citation, threadRef) && !drafted.has(passageKey(citation))
        ? [{ key: `sent:${message.id}:${index}`, citation, draftNumber: null }]
        : [],
    ),
  );
  return [...drafts, ...sentAnnotations];
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
