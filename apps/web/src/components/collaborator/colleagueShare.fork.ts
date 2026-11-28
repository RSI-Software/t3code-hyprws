// Fork-only (colleague-collab): share a thread with a saved colleague in one click, with no link,
// and stop again. The thread menus, the share dialog, and the command palette share these.
import {
  awaitAtomResult,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type ColleagueFork,
  EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { m } from "~/i18n/messages";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { threadSharesQuery } from "./collaboratorAccess.fork";
import { canShareWithCollaboratorFork } from "./collaboratorShareDialogState.fork";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import {
  colleagueForMenuId,
  colleagueShareTargets,
  type ColleagueShareTargetFork,
} from "./colleagueShare.logic.fork";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";

/** The thread menus' Share gate, read from the live server configs. */
export const collaboratorShareOfferedFork = (environmentId: EnvironmentId) =>
  canShareWithCollaboratorFork(appAtomRegistry.get(environmentServerConfigsAtom), environmentId);

const refreshShares = (
  { environmentId, input }: { environmentId: EnvironmentId; input: { threadId: ThreadId } },
  registry: typeof appAtomRegistry,
) =>
  Effect.sync(() =>
    registry.refresh(threadSharesQuery({ environmentId, input: { threadId: input.threadId } })),
  );

export const colleagueShareThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "share thread with colleague",
  tag: WS_METHODS.colleagueShareThreadFork,
  onSuccess: refreshShares,
});

export const unshareThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "stop sharing thread with collaborator",
  tag: WS_METHODS.collaboratorUnshareThreadFork,
  onSuccess: refreshShares,
});

const sharesAtom = ({ environmentId, threadId }: ScopedThreadRef) =>
  threadSharesQuery({ environmentId, input: { threadId } });

const colleagueSharingAllowed = (environmentId: EnvironmentId) =>
  colleaguesServedFork(appAtomRegistry.get(environmentServerConfigsAtom), environmentId) &&
  appAtomRegistry.get(colleagueShareThreadCommand.permissionAtom(environmentId));

// Reads a value only if something already holds the atom, so a menu never starts a request.
const loadedValue = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): A | undefined =>
  Option.getOrUndefined(
    Option.flatMap(appAtomRegistry.getNodes().get(atom)?.valueOption() ?? Option.none(), (result) =>
      AsyncResult.value(result as AsyncResult.AsyncResult<A, E>),
    ),
  );

// `useColleagueListsWarmFork` keeps these loaded.
const loadedColleagues = (environmentId: EnvironmentId): ReadonlyArray<ColleagueFork> =>
  colleagueSharingAllowed(environmentId) ? (loadedValue(colleaguesAtom(environmentId)) ?? []) : [];

/** A thread menu's colleagues as loaded now; empty until `useColleagueShareTargetsWarmFork` has both. */
export function readColleagueShareTargetsFork(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<ColleagueShareTargetFork> {
  if (threadRef === null) return [];
  const saved = loadedColleagues(threadRef.environmentId);
  if (saved.length === 0) return [];
  const shares = loadedValue(sharesAtom(threadRef));
  return shares === undefined ? [] : colleagueShareTargets(saved, shares.sharedWith);
}

/** Keeps the colleagues and this thread's shares loaded, so its menu lists them on first open. */
export function useColleagueShareTargetsWarmFork(threadRef: ScopedThreadRef | null) {
  const environmentId = threadRef?.environmentId ?? null;
  const served =
    colleaguesServedFork(useServerConfigs(), environmentId) &&
    environmentId !== null &&
    readEnvironmentScope(environmentId, AuthAccessWriteScope);
  const colleagues = useEnvironmentQuery(served ? colleaguesAtom(environmentId) : null).data ?? [];
  useEnvironmentQuery(threadRef !== null && colleagues.length > 0 ? sharesAtom(threadRef) : null);
}

/** Keeps each shareable environment's colleague list loaded while the sidebar shows; one each. */
export function useColleagueListsWarmFork() {
  const configs = useServerConfigs();
  const environmentIds = [...configs.keys()].filter(colleagueSharingAllowed).join(" ");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the registry's colleague subscriptions open, so sidebar menus on any environment read them without waiting.
  useEffect(() => {
    const unmounts = environmentIds
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => appAtomRegistry.mount(colleaguesAtom(EnvironmentId.make(id))));
    return () => {
      for (const unmount of unmounts) unmount();
    };
  }, [environmentIds]);
}

/**
 * The sidebar's menu serves every row, so nothing keeps a row's shares warm; with colleagues
 * saved, it loads them as the menu opens. With none, it opens at once.
 */
export function loadColleagueShareTargetsFork(
  threadRef: ScopedThreadRef,
): ReadonlyArray<ColleagueShareTargetFork> | Promise<ReadonlyArray<ColleagueShareTargetFork>> {
  const saved = loadedColleagues(threadRef.environmentId);
  if (saved.length === 0) return [];
  return awaitAtomResult(appAtomRegistry, sharesAtom(threadRef), { refresh: true }).pipe(
    Effect.map((shares) => colleagueShareTargets(saved, shares.sharedWith)),
    // A menu never waits long on a slow server; it opens without colleagues instead.
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed((): ReadonlyArray<ColleagueShareTargetFork> => []),
    Effect.runPromise,
  );
}

/** Shares with an unshared colleague, or stops sharing with a shared one, and says which. */
async function toggleColleagueShareFork(
  threadRef: ScopedThreadRef,
  target: ColleagueShareTargetFork,
): Promise<void> {
  const call = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, subject: target.subject },
  };
  const result = target.shared
    ? await runAtomCommand(appAtomRegistry, unshareThreadCommand, call, { reportFailure: false })
    : await runAtomCommand(appAtomRegistry, colleagueShareThreadCommand, call, {
        reportFailure: false,
      });
  if (isAtomCommandInterrupted(result)) return;
  const name = target.name;
  toastManager.add(
    stackedThreadToast(
      result._tag === "Success"
        ? {
            type: "success",
            title: target.shared
              ? m(msg("Stopped sharing with {name}", { name }))
              : m(msg("Shared with {name}", { name })),
            description: target.shared
              ? m(msg("Their copy freezes, marked Disconnected from host."))
              : m(msg("It shows in their sidebar now. No link needed.")),
          }
        : {
            type: "error",
            title: target.shared
              ? m(msg("Could not stop sharing with {name}", { name }))
              : m(msg("Could not share with {name}", { name })),
            description:
              collaboratorErrorTextFork(squashAtomCommandFailure(result)) ??
              m(msg("An error occurred.")),
          },
    ),
  );
}

/** Runs a thread menu's colleague entry; false for any other entry. */
export function dispatchColleagueShareFork(
  threadRef: ScopedThreadRef,
  action: string,
  targets: ReadonlyArray<ColleagueShareTargetFork>,
): Promise<void> | false {
  const target = colleagueForMenuId(action, targets);
  if (target === null) return false;
  return target === undefined ? Promise.resolve() : toggleColleagueShareFork(threadRef, target);
}
