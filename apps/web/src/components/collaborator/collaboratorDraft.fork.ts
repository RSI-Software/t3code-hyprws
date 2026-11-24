// Fork-only (colleague-collab): the read-only copy of a draft a shared thread shows the others.
// Contexts travel as a kind and label only: never diffs, terminal text, or attachment bytes.
// Citations of this thread travel whole, so others can mark them on the passage they quote.
import {
  COLLABORATOR_DRAFT_CHIPS_MAX,
  COLLABORATOR_DRAFT_TEXT_MAX_CHARS,
  type CollaboratorDraftFork,
  type ThreadId,
} from "@t3tools/contracts";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import {
  replaceComposerContextReferences,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";

import type { ComposerThreadDraftState } from "~/composerDraftStore";
import {
  environmentContextReference,
  fileContextReference,
  imageContextReference,
  previewAnnotationContextReference,
  responseContextReference,
  reviewCommentContextReference,
  terminalContextReference,
  threadContextReference,
} from "~/lib/composerContextRecords";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "~/lib/terminalContext";

type DraftSource = Pick<
  ComposerThreadDraftState,
  | "prompt"
  | "images"
  | "files"
  | "terminalContexts"
  | "reviewComments"
  | "previewAnnotations"
  | "threadContexts"
  | "environmentContexts"
  | "replyTo"
>;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// A draft left alone this long stops showing, so an old one on an idle device never does.
const ACTIVE_MS = 30_000;

/** An idle draft keeps only its citations: they mark passages for as long as they stay cited. */
export function withinActive(
  draft: CollaboratorDraftFork | null,
  idleMs: number,
): CollaboratorDraftFork | null {
  if (draft === null || idleMs < ACTIVE_MS) return draft;
  return draft.citations
    ? { text: "", truncated: false, chips: [], citations: draft.citations }
    : null;
}

/** The draft as others see it, or null when it holds nothing to show. */
export function collaboratorDraftFork(
  draft: DraftSource | null,
  threadId: ThreadId,
): CollaboratorDraftFork | null {
  if (draft === null) return null;
  const citations = collectAssistantCitations(draft.prompt);
  const inline = citations
    .map(({ citation }) => citation)
    .filter((citation) => citation.threadId === threadId)
    .slice(0, COLLABORATOR_DRAFT_CHIPS_MAX);
  const shown = inline.length === 0 ? {} : { citations: inline };
  // This thread's citations show inline on the passage, so the text leaves every citation out.
  let uncited = "";
  let cursor = 0;
  for (const { start, end } of citations) {
    uncited += draft.prompt.slice(cursor, start);
    cursor = end;
  }
  const text = replaceComposerContextReferences(
    uncited + draft.prompt.slice(cursor),
    ({ label }) => label,
  )
    .replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "")
    .trim();
  const chips = [
    ...draft.images.map(imageContextReference),
    ...draft.files.map(fileContextReference),
    ...draft.terminalContexts.map(terminalContextReference),
    ...draft.reviewComments.map(reviewCommentContextReference),
    ...draft.previewAnnotations.map(previewAnnotationContextReference),
    ...draft.threadContexts.map(threadContextReference),
    ...draft.environmentContexts.map(environmentContextReference),
    ...(draft.replyTo === null ? [] : [responseContextReference(draft.replyTo)]),
    ...citations.flatMap(({ citation }) =>
      citation.threadId === threadId
        ? []
        : [{ kind: "citation", label: assistantCitationLabel(citation) }],
    ),
  ]
    .slice(0, COLLABORATOR_DRAFT_CHIPS_MAX)
    .map(({ kind, label }) => ({ kind, label: sanitizeComposerContextLabel(label, kind) }));
  if (text === "" && chips.length === 0 && inline.length === 0) return null;
  if (text.length <= COLLABORATOR_DRAFT_TEXT_MAX_CHARS) {
    return { text, truncated: false, chips, ...shown };
  }
  // The end is what the writer is working on; never start on half a surrogate pair.
  const tail = text.slice(-COLLABORATOR_DRAFT_TEXT_MAX_CHARS);
  return {
    text: isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail,
    truncated: true,
    chips,
    ...shown,
  };
}
