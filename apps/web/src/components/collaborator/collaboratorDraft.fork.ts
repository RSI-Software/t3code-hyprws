// Fork-only (colleague-collab): the read-only copy of a draft a shared thread shows the others.
// Contexts travel as a kind and label only: never diffs, terminal text, or attachment bytes.
import {
  COLLABORATOR_DRAFT_CHIPS_MAX,
  COLLABORATOR_DRAFT_TEXT_MAX_CHARS,
  type CollaboratorDraftFork,
} from "@t3tools/contracts";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

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

const CHIP_LABEL_MAX_CHARS = 200;

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

/** The draft as others see it, or null when it holds nothing to show. */
export function collaboratorDraftFork(draft: DraftSource | null): CollaboratorDraftFork | null {
  if (draft === null) return null;
  const citations = collectAssistantCitations(draft.prompt);
  let quoted = "";
  let cursor = 0;
  for (const { citation, start, end } of citations) {
    quoted += `${draft.prompt.slice(cursor, start)}“${assistantCitationLabel(citation)}”`;
    cursor = end;
  }
  const text = replaceComposerContextReferences(
    quoted + draft.prompt.slice(cursor),
    ({ label }) => label,
  ).replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
  const chips = [
    ...draft.images.map(imageContextReference),
    ...draft.files.map(fileContextReference),
    ...draft.terminalContexts.map(terminalContextReference),
    ...draft.reviewComments.map(reviewCommentContextReference),
    ...draft.previewAnnotations.map(previewAnnotationContextReference),
    ...draft.threadContexts.map(threadContextReference),
    ...draft.environmentContexts.map(environmentContextReference),
    ...(draft.replyTo === null ? [] : [responseContextReference(draft.replyTo)]),
    ...citations.map(({ citation }) => ({
      kind: "citation",
      label: assistantCitationLabel(citation),
    })),
  ]
    .slice(0, COLLABORATOR_DRAFT_CHIPS_MAX)
    .map(({ kind, label }) => ({ kind, label: label.slice(0, CHIP_LABEL_MAX_CHARS) }));
  if (text.trim() === "" && chips.length === 0) return null;
  if (text.length <= COLLABORATOR_DRAFT_TEXT_MAX_CHARS) return { text, truncated: false, chips };
  // The end is what the writer is working on; never start on half a surrogate pair.
  const tail = text.slice(-COLLABORATOR_DRAFT_TEXT_MAX_CHARS);
  return {
    text: isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail,
    truncated: true,
    chips,
  };
}
