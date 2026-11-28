// Fork-only (colleague-collab): which thread has the collaborator share dialog open, and who may open it.
import {
  COLLABORATOR_SHARE_SCOPES,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentScope } from "~/state/session";

type CollaboratorServerConfigs = ReadonlyMap<
  EnvironmentId,
  { readonly environment?: { readonly capabilities: { readonly collaboratorsFork?: boolean } } }
>;

/** Whether `environmentId`'s server runs collaborator sharing; a stock server is never asked. */
export const collaboratorsServedFork = (
  configs: CollaboratorServerConfigs,
  environmentId: EnvironmentId,
) => configs.get(environmentId)?.environment?.capabilities.collaboratorsFork === true;

/** The menus offer sharing only where the server would accept it: its capability and scopes. */
export const canShareWithCollaboratorFork = (
  configs: CollaboratorServerConfigs,
  environmentId: EnvironmentId,
) =>
  collaboratorsServedFork(configs, environmentId) &&
  COLLABORATOR_SHARE_SCOPES.every((scope) => readEnvironmentScope(environmentId, scope));

export const collaboratorShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("collaborator-share:dialog-thread"),
);

export function openCollaboratorShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(collaboratorShareDialogThreadAtom, threadRef);
}
