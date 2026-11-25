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

import { decodeMsg, msg } from "gt-react";

import type { ComposerThreadDraftState } from "~/composerDraftStore";
import type { MessageResolver } from "~/i18n/messages";
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

const PREVIEW_ANNOTATION = msg("Preview annotation");
// The sender writes a review comment's diff range in English, as upstream's records keep it.
const ENGLISH_DIFF_RANGE = /^(.*? )L(\d+)(?: to L(\d+))?( \(before\))?$/u;

/** A chip's label in the viewer's language, as upstream shows its own; people's words stay. */
export function draftChipLabelFork(
  { kind, label }: { readonly kind: string; readonly label: string },
  resolve: MessageResolver,
): string {
  if (kind === "preview-annotation" && label === decodeMsg(PREVIEW_ANNOTATION)) {
    return resolve(PREVIEW_ANNOTATION);
  }
  const range = kind === "review-comment" ? ENGLISH_DIFF_RANGE.exec(label) : null;
  if (range === null) return label;
  const [, file, start, end, before] = range;
  if (end === undefined) {
    return before === undefined
      ? label
      : file +
          resolve(
            msg("L{start} (before)", { $context: "line in the old version of a diff", start }),
          );
  }
  return (
    file +
    (before === undefined
      ? resolve(msg("L{start} to L{end}", { $context: "line range in a diff", start, end }))
      : resolve(
          msg("L{start} to L{end} (before)", {
            $context: "line range in the old version of a diff",
            start,
            end,
          }),
        ))
  );
}

/** The draft's text, with the chip labels it repeats inline in the viewer's language. */
export function draftTextFork(draft: CollaboratorDraftFork, resolve: MessageResolver): string {
  return draft.chips.reduce((text, chip) => {
    const shown = draftChipLabelFork(chip, resolve);
    return shown === chip.label ? text : text.replaceAll(chip.label, shown);
  }, draft.text);
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
