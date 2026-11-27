// Fork-only (colleague-collab): which inbox the sidebar shows, mine or a saved colleague's. Their
// inbox is what my collaborator grant on their server reads; while I browse it, that session
// drops operate, so every surface gating on it turns read-only until I switch back.
import { useAtomValue } from "@effect/atom-react";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** The environment of the colleague whose inbox the sidebar shows; null shows mine. */
export const colleagueInboxAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("colleague-inbox-fork"),
);

const vetoes = (
  browsing: EnvironmentId | null,
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
) => browsing !== null && browsing === environmentId && scope === AuthOrchestrationOperateScope;

/** True when browsing `environmentId`'s inbox withholds `scope` from my session there. */
export const useColleagueInboxVetoFork = (
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
) => useAtomValue(colleagueInboxAtom, (browsing) => vetoes(browsing, environmentId, scope));

export const readColleagueInboxVetoFork = (
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
) => vetoes(appAtomRegistry.get(colleagueInboxAtom), environmentId, scope);

/** True while the sidebar shows a colleague's inbox, so my inbox's thread shortcuts stand down. */
export const readColleagueInboxBrowsingFork = () =>
  appAtomRegistry.get(colleagueInboxAtom) !== null;

/** A forgotten colleague's inbox closes, so a later save of the same server starts in mine. */
export const closeColleagueInboxFork = (environmentId: EnvironmentId) => {
  if (appAtomRegistry.get(colleagueInboxAtom) === environmentId) {
    appAtomRegistry.set(colleagueInboxAtom, null);
  }
};
