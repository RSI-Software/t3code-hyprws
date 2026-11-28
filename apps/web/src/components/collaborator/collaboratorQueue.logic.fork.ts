// Fork-only (colleague-collab): a collaborator's queued line keeps their words, so the host can send
// or cancel it, not rewrite it. The host's own line in a shared thread stays theirs to edit.
import type { CollaboratorAttributionFork } from "@t3tools/contracts";

type QueuedContext =
  | { readonly collaboratorFork?: CollaboratorAttributionFork | undefined }
  | undefined;

export const queuedLineLockedFork = (context: QueuedContext) =>
  context?.collaboratorFork !== undefined && context.collaboratorFork.host !== true;

/** Only the signed-in author changes their line; a namesake's or an older unsigned one is not theirs. */
export const queuedLineOwnedFork = (context: QueuedContext, yourSubject: string) =>
  context?.collaboratorFork?.subject === yourSubject;
