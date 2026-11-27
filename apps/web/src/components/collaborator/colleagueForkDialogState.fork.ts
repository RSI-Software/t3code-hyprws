// Fork-only (colleague-collab): which colleague's thread has the "Fork to my machine" dialog open.
// The menus import this, not the dialog, so they stay free of its components.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const colleagueForkDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("colleague-fork:dialog-thread"),
);

/** A thread a colleague shares with this app, which forks onto this app's own server. */
export const canForkColleagueThreadFork = (
  thread: Pick<EnvironmentThreadShell, "collaboratorFork">,
) => thread.collaboratorFork !== undefined;

export function openColleagueForkDialogFork(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(colleagueForkDialogThreadAtom, threadRef);
}
