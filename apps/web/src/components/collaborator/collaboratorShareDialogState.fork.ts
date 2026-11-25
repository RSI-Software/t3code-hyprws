// Fork-only (colleague-collab): which thread has the collaborator share dialog open, and who may open it.
import {
  COLLABORATOR_SHARE_SCOPES,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentScope } from "~/state/session";

/** The menus offer sharing only where the server would accept it: the share RPC's own scopes. */
export const canShareWithCollaboratorFork = (environmentId: EnvironmentId) =>
  COLLABORATOR_SHARE_SCOPES.every((scope) => readEnvironmentScope(environmentId, scope));

export const collaboratorShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("collaborator-share:dialog-thread"),
);

export function openCollaboratorShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(collaboratorShareDialogThreadAtom, threadRef);
}
