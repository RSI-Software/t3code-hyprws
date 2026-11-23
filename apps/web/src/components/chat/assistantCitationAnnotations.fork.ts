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
