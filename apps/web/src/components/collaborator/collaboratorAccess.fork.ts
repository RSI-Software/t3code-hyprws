// Fork-only (colleague-collab): who a thread is shared with, and their access. The share dialog and
// the thread details card read the same query, which an access change refreshes.
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type CollaboratorAccessFork, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "~/connection/runtime";

export const threadSharesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:collaborator:thread-shares",
  tag: WS_METHODS.collaboratorThreadSharesFork,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const setAccessCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "change collaborator access",
  tag: WS_METHODS.collaboratorSetAccessFork,
  onSuccess: ({ environmentId, input }, registry) =>
    Effect.sync(() =>
      registry.refresh(threadSharesQuery({ environmentId, input: { threadId: input.threadId } })),
    ),
});

export const ACCESS: Record<CollaboratorAccessFork, { label: string; detail: string }> = {
  approve: { label: "Needs approval", detail: "Each message waits for you to send it" },
  send: { label: "Can send", detail: "Messages go straight to the agent" },
};

/** A collaborator's copy is the host's thread, so pinning, settling, and snoozing stay the host's. */
export const collaboratorRowControlsFork = (thread: { readonly collaboratorFork?: string }) =>
  thread.collaboratorFork === undefined
    ? {}
    : { settlementSupported: false, snoozeSupported: false, pinningSupported: false };
