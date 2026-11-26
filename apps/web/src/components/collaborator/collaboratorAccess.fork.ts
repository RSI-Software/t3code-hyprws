// Fork-only (colleague-collab): who a thread is shared with, and their access. The share dialog and
// the thread details card read the same query, which an access change refreshes.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CollaboratorAccessFork,
  type EnvironmentId,
  isCollaboratorGrantFork,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";

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
  approve: { label: msg("Needs approval"), detail: msg("Each message waits for you to send it") },
  send: { label: msg("Can send"), detail: msg("Messages go straight to the agent") },
};

/** A collaborator's copy is the host's thread, so pinning, settling, and snoozing stay the host's. */
export const collaboratorRowControlsFork = (thread: { readonly collaboratorFork?: string }) =>
  thread.collaboratorFork === undefined
    ? {}
    : { settlementSupported: false, snoozeSupported: false, pinningSupported: false };

const useHostSessionFork = (environmentId: EnvironmentId) =>
  useAtomValue(
    environmentSession.sessionStateValueAtom(environmentId),
    (session) => session !== null && !isCollaboratorGrantFork(session.permissions),
  );

/** Automations stay the host's: a collaborator session, or one still loading, never asks for them. */
export const useHostScheduledTasksFork = (environmentId: EnvironmentId, needed = true) =>
  useHostSessionFork(environmentId) && needed
    ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
    : null;
