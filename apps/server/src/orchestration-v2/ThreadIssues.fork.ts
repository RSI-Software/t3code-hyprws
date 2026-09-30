// Fork-owned thread ↔ GitHub issue links on Orchestrator V2
// (RSI-Software/t3code-hyprws#1431). Links live on the app thread itself, so the
// V2 projector stores them inside the thread payload with no table of their own.
// `Orchestrator.ts` routes the three issue commands here through marked hooks;
// each accepted command emits the upstream `thread.metadata-updated` event, whose
// payload is the whole thread, so no upstream client ever receives a fork-only
// event type. Links never settle a thread.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  ThreadIssueKey,
  ThreadIssueLink,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export type ThreadIssueCommandFork = Extract<
  OrchestrationV2ServerCommand,
  { type: "thread.issue.link" | "thread.issue.unlink" | "thread.issue-link.sync" }
>;

/** Issue keys share the pull request key normalization: host and repository lowercased. */
export const normalizeThreadIssueKey = (key: ThreadIssueKey): ThreadIssueKey =>
  normalizeThreadPullRequestKey({ host: key.host, repository: key.repository, number: key.number });

export const threadIssueKeysEqual = (left: ThreadIssueKey, right: ThreadIssueKey): boolean =>
  threadPullRequestKeysEqual(normalizeThreadIssueKey(left), normalizeThreadIssueKey(right));

/** A thread's links; a thread from before links has none. */
export const threadIssuesOf = (thread: {
  readonly issues?: ReadonlyArray<ThreadIssueLink>;
}): ReadonlyArray<ThreadIssueLink> => thread.issues ?? [];

/**
 * The thread's `issues` key: omitted when there are none, like a thread from
 * before links, so every read serves a link-free thread unchanged.
 */
export const threadIssuesField = (
  issues: ReadonlyArray<ThreadIssueLink> | undefined,
): { readonly issues?: ReadonlyArray<ThreadIssueLink> } =>
  issues === undefined || issues.length === 0 ? {} : { issues };

/** `thread` with exactly `issues`, the key dropped when the last link goes. */
export const withThreadIssues = <T extends { readonly issues?: ReadonlyArray<ThreadIssueLink> }>(
  thread: T,
  issues: ReadonlyArray<ThreadIssueLink>,
): T => {
  const { issues: _previous, ...rest } = thread;
  return { ...rest, ...threadIssuesField(issues) } as T;
};

/**
 * A snapshot read before the link existed describes an earlier link, and one
 * read before the stored snapshot lost a race to it; both are dropped.
 */
const isStaleThreadIssueSync = (link: ThreadIssueLink, syncedAt: string): boolean =>
  compareDateTimeStrings(syncedAt, link.linkedAt) < 0 ||
  (link.snapshot !== null && compareDateTimeStrings(syncedAt, link.snapshot.syncedAt) < 0);

const describeKey = (key: ThreadIssueKey) => `issue ${key.host}/${key.repository}#${key.number}`;

/**
 * The thread an issue command leaves, or the reason it is refused. A duplicate
 * link, an unknown unlink, and a stale or unknown sync are refused, so a no-op
 * never reaches the event log.
 */
const decideThreadIssueCommandFork = (
  thread: OrchestrationV2AppThread,
  command: ThreadIssueCommandFork,
  now: DateTime.Utc,
): OrchestrationV2AppThread | { readonly refused: string } => {
  const key = normalizeThreadIssueKey(command);
  const links = threadIssuesOf(thread);
  const existing = links.find((link) => threadIssueKeysEqual(link, key));
  if (thread.deletedAt !== null) {
    return { refused: `Thread ${command.threadId} is deleted.` };
  }
  switch (command.type) {
    case "thread.issue.link":
      if (existing !== undefined) {
        return {
          refused: `${describeKey(key)} is already linked to thread ${command.threadId}.`,
        };
      }
      return {
        ...withThreadIssues(thread, [
          ...links,
          {
            ...key,
            url: command.url,
            source: command.source,
            linkedAt: DateTime.formatIso(now),
            snapshot: null,
          },
        ]),
        updatedAt: now,
      };
    case "thread.issue.unlink":
      if (existing === undefined) {
        return { refused: `${describeKey(key)} is not linked to thread ${command.threadId}.` };
      }
      return {
        ...withThreadIssues(
          thread,
          links.filter((link) => link !== existing),
        ),
        updatedAt: now,
      };
    case "thread.issue-link.sync":
      if (existing === undefined) {
        return { refused: `${describeKey(key)} is not linked to thread ${command.threadId}.` };
      }
      if (isStaleThreadIssueSync(existing, command.snapshot.syncedAt)) {
        return {
          refused: `${describeKey(key)} sync predates its link or its stored snapshot.`,
        };
      }
      // A host read is not thread activity: the sidebar order stays put.
      return withThreadIssues(
        thread,
        links.map((link) => (link === existing ? { ...link, snapshot: command.snapshot } : link)),
      );
  }
};

/**
 * Dispatches one issue command inside the orchestrator's command transaction.
 * The orchestrator passes its own thread read, event emitter and error mapping,
 * so this module never imports `Orchestrator.ts` back.
 */
export const dispatchThreadIssueCommandFork = Effect.fn("dispatchThreadIssueCommandFork")(
  function* <E, R1, R2>(input: {
    readonly command: ThreadIssueCommandFork;
    readonly getThread: Effect.Effect<OrchestrationV2AppThread, E, R1>;
    readonly emit: (event: Omit<OrchestrationV2DomainEvent, "id">) => Effect.Effect<unknown, E, R2>;
    readonly refuse: (cause: string) => Effect.Effect<never, E>;
  }) {
    const thread = yield* input.getThread;
    const now = yield* DateTime.now;
    const decided = decideThreadIssueCommandFork(thread, input.command, now);
    if ("refused" in decided) return yield* input.refuse(decided.refused);
    yield* input.emit({
      type: "thread.metadata-updated",
      threadId: input.command.threadId,
      providerInstanceId: decided.providerInstanceId,
      occurredAt: now,
      payload: decided,
    });
  },
);
