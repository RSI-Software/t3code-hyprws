// Fork-only (colleague-collab): which thread has the colleague share dialog open.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const colleagueShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("colleague-share:dialog-thread"),
);

export function openColleagueShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(colleagueShareDialogThreadAtom, threadRef);
}
