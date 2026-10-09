import type { ScopedThreadRef } from "@t3tools/contracts";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";
import { collectInlineContextIds } from "../lib/composerContextReferences";
import {
  fileContextReference,
  previewAnnotationContextId,
  reviewCommentContextId,
  terminalContextReference,
} from "../lib/composerContextRecords";

/** Empty drafts can lack prompt storage; existence comes from their thread or draft session. */
export function readVoiceDraftTextFork(target: ScopedThreadRef | DraftId): string | null {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const exists =
    typeof target === "string"
      ? store.getDraftSession(target) !== null || draft !== null
      : readThreadShell(target) !== null || store.getDraftSessionByRef(target) !== null;
  return exists ? (draft?.prompt ?? "") : null;
}

/** Replacing a selected chip also removes its payload when no editor is mounted. */
export function commitVoiceDraftFork(target: ScopedThreadRef | DraftId, text: string) {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  store.setPrompt(target, text);
  if (!draft) return;
  const referenced = new Set(collectInlineContextIds(text));
  const removed = new Set(
    collectInlineContextIds(draft.prompt).filter((id) => !referenced.has(id)),
  );
  for (const context of draft.terminalContexts) {
    if (removed.has(terminalContextReference(context).contextId))
      store.removeTerminalContext(target, context.id);
  }
  for (const comment of draft.reviewComments) {
    if (removed.has(reviewCommentContextId(comment.id)))
      store.removeReviewComment(target, comment.id);
  }
  for (const annotation of draft.previewAnnotations) {
    if (removed.has(previewAnnotationContextId(annotation.id)))
      store.removePreviewAnnotation(target, annotation.id);
  }
  for (const file of draft.files) {
    if (removed.has(fileContextReference(file).contextId)) store.removeFile(target, file.id);
  }
  if (draft.threadContexts.some((record) => removed.has(record.contextId))) {
    store.setThreadContexts(
      target,
      draft.threadContexts.filter((record) => !removed.has(record.contextId)),
    );
  }
}
