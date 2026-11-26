// Fork-only (colleague-collab): a collaborator's queued line keeps their words, so the host can send
// or cancel it, not rewrite it. The host's own line in a shared thread stays theirs to edit.
import type { CollaboratorAttributionFork } from "@t3tools/contracts";

export const queuedLineLockedFork = (
  context: { readonly collaboratorFork?: CollaboratorAttributionFork | undefined } | undefined,
) => context?.collaboratorFork !== undefined && context.collaboratorFork.host !== true;
