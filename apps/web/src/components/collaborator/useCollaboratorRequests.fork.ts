// Fork-only (colleague-collab): the host's waiting collaborator messages, one subscription per
// environment that serves collaborators, shared by the thread view and every sidebar card.
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type CollaboratorMessageFork, WS_METHODS } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs } from "~/state/entities";
import { createMergedEnvironmentQueryFork } from "~/state/pullRequests.fork";
import { threadFamilies } from "~/state/threads";
import {
  type CollaboratorRequestersFork,
  type CollaboratorRequestShellFork,
  collaboratorRequestKeyFork,
  groupCollaboratorRequestsFork,
  requestedFamiliesToMountFork,
  withCollaboratorRequestsFork,
} from "./collaboratorRequests.logic.fork";

/** Every waiting message the session may see in one environment: all of them for the host. */
export const collaboratorMessages = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:collaborator:messages",
    tag: WS_METHODS.collaboratorSubscribeMessagesFork,
  },
);

const useServedMessages = createMergedEnvironmentQueryFork(
  "environment-data:collaborator:requests",
  collaboratorMessages,
);

function useCollaboratorRequestsFork() {
  const configs = useServerConfigs();
  const targets = [...configs]
    .filter(([, config]) => config.environment?.capabilities.collaboratorsFork === true)
    .map(([environmentId]) => ({ environmentId, input: {} }));
  return groupCollaboratorRequestsFork(new Map(useServedMessages(targets).values));
}

const NO_KEYS: readonly string[] = [];

/** Reads the family of each requested thread the shells leave out, as an open thread's route does. */
function useRequestedThreadFamiliesFork(
  requests: ReadonlyMap<string, readonly CollaboratorMessageFork[]>,
  threads: readonly CollaboratorRequestShellFork[],
) {
  const [mounted, setMounted] = useState(NO_KEYS);
  const next =
    requests.size === 0 && mounted.length === 0
      ? NO_KEYS
      : requestedFamiliesToMountFork({
          requested: requests.keys(),
          loaded: new Set(threads.map(collaboratorRequestKeyFork)),
          mounted,
        });
  const mountedKey = mounted.join("\n");
  if (next.join("\n") !== mountedKey) setMounted(next);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds requested threads' families in the thread family registry while their requests wait
  useEffect(() => {
    const releases = mountedKey.split("\n").flatMap((key) => {
      const ref = key === "" ? null : parseScopedThreadKey(key);
      return ref === null
        ? []
        : [threadFamilies.mount(appAtomRegistry, ref.environmentId, ref.threadId)];
    });
    return () => {
      for (const release of releases) release();
    };
  }, [mountedKey]);
}

/** The sidebar's threads with their waiting requests; the same list when none wait. */
export function useThreadsWithCollaboratorRequestsFork<T extends CollaboratorRequestShellFork>(
  threads: readonly T[],
): readonly T[] {
  const requests = useCollaboratorRequestsFork();
  useRequestedThreadFamiliesFork(requests, threads);
  if (requests.size === 0) return threads;
  return threads.map((thread) =>
    withCollaboratorRequestsFork(thread, requests.get(collaboratorRequestKeyFork(thread))),
  );
}

/** One card's live thread with its waiting requests. */
export function useThreadWithCollaboratorRequestsFork<T extends CollaboratorRequestShellFork>(
  thread: T,
): T & CollaboratorRequestersFork {
  const requests = useCollaboratorRequestsFork();
  return withCollaboratorRequestsFork(thread, requests.get(collaboratorRequestKeyFork(thread)));
}
