import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { RemoteEnvironmentAuthTimeoutError } from "@t3tools/client-runtime/rpc";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { readThreadShells } from "../state/entities";
import { useUiStateStore, type SidebarThreadGroup } from "../uiStateStore";
import { sidebarThreadGroupKey } from "./SidebarThreadGroup.markers";
import { stackedThreadToast, toastManager } from "./ui/toast";

type GroupSnapshot = Pick<SidebarThreadGroup, "title" | "threadIds">;

interface TitleThread {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface ThreadGroupTitleRequest<T> {
  readonly projectKey: string;
  readonly groupId: string;
  readonly members: readonly T[];
  readonly expectedGroup: GroupSnapshot;
  readonly previousTitle?: string | undefined;
}

export interface ThreadGroupTitleDeps<T extends TitleThread> {
  readonly generate: (request: {
    readonly environmentId: T["environmentId"];
    readonly input: {
      readonly projectId: T["projectId"];
      readonly memberTitles: readonly string[];
      readonly previousTitle?: string;
    };
  }) => Promise<AtomCommandResult<{ readonly title: string }, unknown>>;
  /** Every group and thread, not only the ones the sidebar scope shows. */
  readonly readGroups: () => Readonly<Record<string, readonly SidebarThreadGroup[]>>;
  readonly readThreads: () => readonly T[];
  readonly keyOf: (thread: T) => string;
  readonly renameIfCurrent: (
    projectKey: string,
    groupId: string,
    expected: GroupSnapshot,
    title: string,
  ) => void;
  readonly toasts: {
    readonly add: (
      options: ReturnType<typeof stackedThreadToast> & { readonly onClose: () => void },
    ) => string;
    readonly close: (toastId: string) => void;
  };
  readonly onGeneratingChange: (groupKeys: ReadonlySet<string>) => void;
}

/**
 * The toast description for a failed group title request, or null when the
 * request was only interrupted: a cancellation is the caller's own doing.
 */
export function threadGroupTitleFailureDescription(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (error instanceof RemoteEnvironmentAuthTimeoutError) {
    return `The text generation model did not answer within ${Math.round(error.timeoutMs / 1000)} seconds.`;
  }
  return error instanceof Error && error.message.length > 0 ? error.message : "An error occurred.";
}

function sameGroup(group: GroupSnapshot, expected: GroupSnapshot): boolean {
  return (
    group.title === expected.title &&
    group.threadIds.length === expected.threadIds.length &&
    expected.threadIds.every((threadId) => group.threadIds.includes(threadId))
  );
}

/**
 * Owns every group title request: one request and at most one failure toast
 * per group. A failure toast stays until dismissed and closes itself once the
 * group it names is renamed, changes members, or is gone. Retry resolves the
 * group from the store, so it works whatever the sidebar currently shows.
 */
function createThreadGroupTitleRequests<T extends TitleThread>(deps: ThreadGroupTitleDeps<T>) {
  const inFlight = new Set<string>();
  const failures = new Map<
    string,
    {
      readonly toastId: string;
      readonly projectKey: string;
      readonly groupId: string;
      readonly expected: GroupSnapshot;
      readonly regenerate: boolean;
    }
  >();

  const currentGroup = (projectKey: string, groupId: string) =>
    deps.readGroups()[projectKey]?.find((group) => group.id === groupId);
  const setInFlight = (groupKey: string, running: boolean) => {
    if (running) inFlight.add(groupKey);
    else inFlight.delete(groupKey);
    deps.onGeneratingChange(new Set(inFlight));
  };
  const clearFailure = (groupKey: string) => {
    const failure = failures.get(groupKey);
    if (failure === undefined) return;
    failures.delete(groupKey);
    deps.toasts.close(failure.toastId);
  };

  const retry = (groupKey: string) => {
    const failure = failures.get(groupKey);
    clearFailure(groupKey);
    const group = failure && currentGroup(failure.projectKey, failure.groupId);
    if (failure === undefined || group === undefined) return;
    const byKey = new Map(deps.readThreads().map((thread) => [deps.keyOf(thread), thread]));
    const members = group.threadIds.flatMap((threadId) => byKey.get(threadId) ?? []);
    void request({
      projectKey: failure.projectKey,
      groupId: failure.groupId,
      members,
      expectedGroup: { title: group.title, threadIds: [...group.threadIds] },
      // A regenerate asks for a title unlike the one the group has now.
      ...(failure.regenerate ? { previousTitle: group.title } : {}),
    });
  };

  const request = async (input: ThreadGroupTitleRequest<T>): Promise<void> => {
    const first = input.members[0];
    if (
      !first ||
      input.members.length < 2 ||
      input.members.some(
        (thread) =>
          thread.environmentId !== first.environmentId || thread.projectId !== first.projectId,
      )
    ) {
      return;
    }
    const groupKey = sidebarThreadGroupKey(input.projectKey, input.groupId);
    if (inFlight.has(groupKey)) return;
    clearFailure(groupKey);
    setInFlight(groupKey, true);
    try {
      const result = await deps.generate({
        environmentId: first.environmentId,
        input: {
          projectId: first.projectId,
          memberTitles: input.members.map((thread) => thread.title),
          ...(input.previousTitle === undefined ? {} : { previousTitle: input.previousTitle }),
        },
      });
      if (result._tag === "Success") {
        deps.renameIfCurrent(
          input.projectKey,
          input.groupId,
          input.expectedGroup,
          result.value.title,
        );
        return;
      }
      const description = threadGroupTitleFailureDescription(result);
      const group = currentGroup(input.projectKey, input.groupId);
      // A group changed since the request no longer wants this title.
      if (description === null || !group || !sameGroup(group, input.expectedGroup)) return;
      const toastId = deps.toasts.add({
        ...stackedThreadToast({
          type: "error",
          title: `Failed to name "${group.title}" (${group.threadIds.length} threads)`,
          description,
          timeout: 0,
          actionProps: { children: "Retry", onClick: () => retry(groupKey) },
        }),
        onClose: () => {
          if (failures.get(groupKey)?.toastId === toastId) failures.delete(groupKey);
        },
      });
      failures.set(groupKey, {
        toastId,
        projectKey: input.projectKey,
        groupId: input.groupId,
        expected: { title: group.title, threadIds: [...group.threadIds] },
        regenerate: input.previousTitle !== undefined,
      });
    } finally {
      setInFlight(groupKey, false);
    }
  };

  /** Close each failure toast whose group was renamed, regrouped, or removed. */
  const pruneStale = () => {
    for (const [groupKey, failure] of failures) {
      const group = currentGroup(failure.projectKey, failure.groupId);
      if (!group || !sameGroup(group, failure.expected)) clearFailure(groupKey);
    }
  };

  return { request, retry, pruneStale };
}

type SidebarBinding<T extends TitleThread> = Pick<ThreadGroupTitleDeps<T>, "generate">;

/**
 * Outlives any one sidebar mount. The sidebar unmounts on routes like
 * Settings while toasts stay up, so a remount rebinds its command here
 * instead of starting a second controller beside the old toasts. Threads are
 * read live, so a retry sees titles edited while the sidebar was away.
 */
export function createThreadGroupTitleOwner<T extends TitleThread>(
  deps: Omit<ThreadGroupTitleDeps<T>, "generate" | "onGeneratingChange">,
) {
  let binding: SidebarBinding<T> | null = null;
  let generating: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const controller = createThreadGroupTitleRequests<T>({
    ...deps,
    // A mounted sidebar starts the first request, so a binding exists by then.
    generate: (request) =>
      binding?.generate(request) ?? Promise.resolve(AsyncResult.failure(Cause.interrupt())),
    onGeneratingChange: (groupKeys) => {
      generating = groupKeys;
      for (const listener of listeners) listener();
    },
  });
  return {
    request: controller.request,
    pruneStale: controller.pruneStale,
    bind: (next: SidebarBinding<T>) => {
      binding = next;
    },
    generating: () => generating,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

let appOwner: ReturnType<typeof createThreadGroupTitleOwner<EnvironmentThreadShell>> | null = null;

function appThreadGroupTitles() {
  if (appOwner !== null) return appOwner;
  appOwner = createThreadGroupTitleOwner<EnvironmentThreadShell>({
    readGroups: () => useUiStateStore.getState().threadGroupsByProject,
    readThreads: readThreadShells,
    keyOf: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    renameIfCurrent: (...args) => useUiStateStore.getState().renameThreadGroupIfCurrent(...args),
    toasts: {
      add: (options) => toastManager.add(options),
      close: (toastId) => toastManager.close(toastId),
    },
  });
  useUiStateStore.subscribe(appOwner.pruneStale);
  return appOwner;
}

/** Sidebar binding to the app-wide owner of group title requests. */
export function useThreadGroupTitlesFork(
  generate: ThreadGroupTitleDeps<EnvironmentThreadShell>["generate"],
) {
  const owner = appThreadGroupTitles();
  useEffect(() => owner.bind({ generate }), [owner, generate]);
  const generatingGroupIds = useSyncExternalStore(owner.subscribe, owner.generating);
  return { requestThreadGroupTitle: owner.request, generatingGroupIds };
}
