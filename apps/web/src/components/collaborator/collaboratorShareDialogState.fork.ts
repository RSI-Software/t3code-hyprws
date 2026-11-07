// Fork-only (colleague-collab): which thread has the collaborator share dialog open.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const collaboratorShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("collaborator-share:dialog-thread"),
);

export function openCollaboratorShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(collaboratorShareDialogThreadAtom, threadRef);
}
