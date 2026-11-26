// Fork-only (colleague-collab): a collaborator's message waiting for the host is a request on the
// host's thread card. It rides upstream's guest-request attention, so the card reads "Requested",
// never recedes, wakes from a snooze and leaves Settled for the top of the inbox until the host
// sends or dismisses it. Nothing is stored: it derives from the waiting messages the host streams.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { CollaboratorMessageFork, EnvironmentId } from "@t3tools/contracts";
import type { useGT } from "gt-react";

export type CollaboratorRequestShellFork = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "collaboratorFork"
  | "pendingGuestMessageCount"
  | "settledOverride"
  | "settledAt"
  | "unsettledAt"
>;

/** Who is waiting on the host, oldest first; set only while a request waits. */
export interface CollaboratorRequestersFork {
  readonly collaboratorRequestersFork?: readonly string[];
}

const NO_REQUESTS: ReadonlyMap<string, readonly CollaboratorMessageFork[]> = new Map();

export const collaboratorRequestKeyFork = (
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Waiting messages by scoped thread key. */
export function groupCollaboratorRequestsFork(
  byEnvironment: ReadonlyMap<EnvironmentId, readonly CollaboratorMessageFork[]>,
): ReadonlyMap<string, readonly CollaboratorMessageFork[]> {
  const requests = new Map<string, CollaboratorMessageFork[]>();
  for (const [environmentId, messages] of byEnvironment) {
    for (const message of messages) {
      const key = collaboratorRequestKeyFork({ environmentId, id: message.threadId });
      requests.set(key, [...(requests.get(key) ?? []), message]);
    }
  }
  return requests.size === 0 ? NO_REQUESTS : requests;
}

/**
 * Requested threads whose family the sidebar keeps read: those the shells leave out (older settled
 * ones), and those already read while their request waits, since the read brings their row in.
 */
export function requestedFamiliesToMountFork(input: {
  readonly requested: Iterable<string>;
  readonly loaded: ReadonlySet<string>;
  readonly mounted: readonly string[];
}): readonly string[] {
  return [...input.requested]
    .filter((key) => !input.loaded.has(key) || input.mounted.includes(key))
    .toSorted();
}

/** The thread as its host's sidebar sees it while `waiting` holds requests for it. */
export function withCollaboratorRequestsFork<T extends CollaboratorRequestShellFork>(
  thread: T,
  waiting: readonly CollaboratorMessageFork[] | undefined,
): T & CollaboratorRequestersFork {
  // A collaborator's own copy shows its sent state elsewhere; only the host is asked.
  if (waiting === undefined || waiting.length === 0 || thread.collaboratorFork !== undefined) {
    return thread;
  }
  const latest = waiting.reduce(
    (at, message) => (message.submittedAt > at ? message.submittedAt : at),
    thread.unsettledAt ?? "",
  );
  return {
    ...thread,
    pendingGuestMessageCount: (thread.pendingGuestMessageCount ?? 0) + waiting.length,
    // As a guest message does, a request brings a settled thread back to the top of the inbox.
    ...(thread.settledOverride === "settled" ? { settledOverride: null, settledAt: null } : {}),
    unsettledAt: latest,
    collaboratorRequestersFork: [...new Set(waiting.map((message) => message.name))],
  };
}

/** The card's status label naming who asked; empty leaves upstream's guest label. */
export function collaboratorRequestedLabelFork(
  gt: ReturnType<typeof useGT>,
  thread: Pick<EnvironmentThreadShell, "id"> & CollaboratorRequestersFork,
): { readonly label?: string } {
  const [first, ...others] = thread.collaboratorRequestersFork ?? [];
  if (first === undefined) return {};
  const label = gt("Requested by {name}", {
    name: first,
    $context: "thread status: a collaborator's message waits for the host",
  });
  return { label: others.length === 0 ? label : `${label} +${others.length}` };
}
