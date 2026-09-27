// Fork-only: client state for the `thread.fork` RPC — the per-thread "Fork
// thread" menu action. The command rides the environment-scoped RPC runtime;
// the in-flight set disables the menu item for the duration of a fork so an
// in-flight request cannot be double-fired from either menu surface.
import { WS_METHODS, type ProviderDriverKind } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";

export const threadForkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:threads:fork",
  tag: WS_METHODS.threadFork,
});

const inFlightForks = new Set<string>();

export const forkInFlight = (threadKey: string): boolean => inFlightForks.has(threadKey);

export const setForkInFlight = (threadKey: string, inFlight: boolean): void => {
  if (inFlight) {
    inFlightForks.add(threadKey);
  } else {
    inFlightForks.delete(threadKey);
  }
};

/**
 * The thread's provider driver, read at menu-open time without hooks: the
 * live session's instance wins over the model selection's, matching how rows
 * resolve their provider entry.
 */
export const readForkProviderFork = (
  threadRef: ScopedThreadRef,
  thread: EnvironmentThreadShell,
): ProviderDriverKind | null => {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  const driver = config?.providers.find((provider) => provider.instanceId === instanceId)?.driver;
  return driver ?? null;
};
