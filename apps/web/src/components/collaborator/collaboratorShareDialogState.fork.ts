// Fork-only (colleague-collab): which thread has the collaborator share dialog open, and who may open it.
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ScopedThreadRef, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export const shareThreadWithCollaboratorCommand = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  { label: "share thread with collaborator", tag: WS_METHODS.collaboratorShareThreadFork },
);

/** The menus offer sharing only where the server would accept it. */
export const canShareWithCollaboratorFork = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(shareThreadWithCollaboratorCommand.permissionAtom(environmentId));

export const collaboratorShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("collaborator-share:dialog-thread"),
);

export function openCollaboratorShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(collaboratorShareDialogThreadAtom, threadRef);
}
