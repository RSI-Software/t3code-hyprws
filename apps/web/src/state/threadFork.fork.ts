// Fork-only: client state for the per-thread "Fork thread" menu action. It
// dispatches orchestration V2 `thread.fork` from the source's latest stable
// run through the environment-scoped dispatch RPC; the in-flight set disables
// the menu item for the duration of a fork so an in-flight request cannot be
// double-fired from either menu surface.
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { newThreadId, randomUUID } from "../lib/utils";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "./threads";
import { environmentServerConfigsAtom } from "./server";

export const threadForkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:threads:fork",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});

/** Forking an already-forked title must not stack the suffix. */
const forkTitleFork = (title: string): string => `${title.replace(/ \(fork\)$/, "")} (fork)`;

/** The V2 `thread.fork` a menu click dispatches; the client owns the child id. */
export const buildLatestStableForkCommandFork = (input: {
  readonly sourceThreadId: ThreadId;
  readonly title: string;
  readonly targetThreadId?: ThreadId;
}): Extract<OrchestrationV2Command, { readonly type: "thread.fork" }> => ({
  type: "thread.fork",
  commandId: CommandId.make(randomUUID()),
  createdBy: "user",
  creationSource: "web",
  sourceThreadId: input.sourceThreadId,
  targetThreadId: input.targetThreadId ?? newThreadId(),
  sourcePoint: { type: "latest_stable" },
  title: forkTitleFork(input.title),
});

const inFlightForks = new Set<string>();

export const forkInFlight = (threadKey: string): boolean => inFlightForks.has(threadKey);

/** `forkInFlight` keyed by the thread ref, for surfaces that hold no thread key. */
export const forkRefInFlightFork = (threadRef: ScopedThreadRef): boolean =>
  forkInFlight(scopedThreadKey(threadRef));

export const setForkInFlight = (threadKey: string, inFlight: boolean): void => {
  if (inFlight) {
    inFlightForks.add(threadKey);
  } else {
    inFlightForks.delete(threadKey);
  }
};

/**
 * Resolves `true` once the thread's shell reaches the client store, `false`
 * on timeout. A fork's RPC reply races the child's shell projection: the
 * thread route reads a missing shell as a dead thread and bounces to the
 * index, so the fork dispatch must land only after the store has the child.
 */
export const waitForChildShellFork = (
  ref: ScopedThreadRef,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const shellAtom = environmentThreadShells.threadShellAtom(ref);
  if (appAtomRegistry.get(shellAtom) !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(false);
    }, timeoutMs);
    const check = () => {
      if (appAtomRegistry.get(shellAtom) === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(true);
    };
    unsubscribe = appAtomRegistry.subscribe(shellAtom, check);
  });
};

/** The source title a fork names its child after, read from the shell store. */
export const readForkSourceTitleFork = (ref: ScopedThreadRef): string | null =>
  appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref))?.title ?? null;

/**
 * The thread's provider driver, read at menu-open time without hooks: the
 * live runtime's instance wins over the thread's own, matching how rows
 * resolve their provider entry.
 */
export const readForkProviderFork = (
  threadRef: ScopedThreadRef,
  thread: EnvironmentThreadShell,
): ProviderDriverKind | null => {
  const instanceId = thread.runtime?.providerInstanceId ?? thread.providerInstanceId;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  const driver = config?.providers.find((provider) => provider.instanceId === instanceId)?.driver;
  return driver ?? null;
};
