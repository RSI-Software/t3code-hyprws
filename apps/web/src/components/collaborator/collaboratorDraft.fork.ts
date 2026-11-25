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
  collectComposerContextReferences,
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

/** The draft's text with its generated labels translated; typed words stay as written. */
export function draftTextFork(draft: CollaboratorDraftFork, resolve: MessageResolver): string {
  let text = "";
  let cursor = 0;
  for (const { start, end, kind } of draft.inline ?? []) {
    if (start < cursor || end < start || end > draft.text.length) continue;
    const label = draftChipLabelFork({ kind, label: draft.text.slice(start, end) }, resolve);
    text += draft.text.slice(cursor, start) + label;
    cursor = end;
  }
  return text + draft.text.slice(cursor);
}

/** The draft as others see it, or null when it holds nothing to show. */
export function collaboratorDraftFork(
  draft: DraftSource | null,
  threadId: ThreadId,
): CollaboratorDraftFork | null {
  if (draft === null) return null;
  const citations = collectAssistantCitations(draft.prompt);
  const cited = citations
    .map(({ citation }) => citation)
    .filter((citation) => citation.threadId === threadId)
    .slice(0, COLLABORATOR_DRAFT_CHIPS_MAX);
  const shown = cited.length === 0 ? {} : { citations: cited };
  // This thread's citations show inline on the passage, so the text leaves every citation out.
  let uncited = "";
  let cursor = 0;
  for (const { start, end } of citations) {
    uncited += draft.prompt.slice(cursor, start);
    cursor = end;
  }
  // Each context shows as its label; where it sits lets others translate only that label.
  const source = (uncited + draft.prompt.slice(cursor)).replaceAll(
    INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
    "",
  );
  let flat = "";
  let read = 0;
  const generated: Array<{ start: number; end: number; kind: string }> = [];
  for (const { start, end, label, kind } of collectComposerContextReferences(source)) {
    flat += source.slice(read, start);
    generated.push({ start: flat.length, end: flat.length + label.length, kind });
    flat += label;
    read = end;
  }
  flat += source.slice(read);
  const text = flat.trim();
  const spans = (offset: number) => {
    const kept = generated
      .map((span) => ({ ...span, start: span.start - offset, end: span.end - offset }))
      .filter(({ start }) => start >= 0)
      .slice(0, COLLABORATOR_DRAFT_CHIPS_MAX);
    return kept.length === 0 ? {} : { inline: kept };
  };
  const leading = flat.length - flat.trimStart().length;
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
  if (text === "" && chips.length === 0 && cited.length === 0) return null;
  if (text.length <= COLLABORATOR_DRAFT_TEXT_MAX_CHARS) {
    return { text, truncated: false, chips, ...spans(leading), ...shown };
  }
  // The end is what the writer is working on; never start on half a surrogate pair.
  const tail = text.slice(-COLLABORATOR_DRAFT_TEXT_MAX_CHARS);
  const cut = isLowSurrogate(tail.charCodeAt(0)) ? 1 : 0;
  return {
    text: tail.slice(cut),
    truncated: true,
    chips,
    ...spans(leading + text.length - tail.length + cut),
    ...shown,
  };
}
