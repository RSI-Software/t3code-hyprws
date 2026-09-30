// Fork-owned decider and in-memory projector for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1431). `decider.ts` and `projector.ts` dispatch
// here through marked hooks before their switches, so neither switch ever sees a
// `thread.issue*` command or event. Pure like its upstream callers. Links never
// settle a thread: no settlement reactor reads these events.
import {
  ThreadIssueLinkedPayload,
  ThreadIssueSyncedPayload,
  ThreadIssueUnlinkedPayload,
  type CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadIssueKey,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { requireThread } from "./commandInvariants.ts";
import {
  OrchestrationCommandInvariantError,
  toProjectorDecodeError,
  type OrchestrationCommandRejection,
  type OrchestrationProjectorDecodeError,
} from "./Errors.ts";

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

const THREAD_ISSUE_COMMAND_TYPES = new Set<OrchestrationCommand["type"]>([
  "thread.issue.link",
  "thread.issue.unlink",
  "thread.issue-link.sync",
]);

const THREAD_ISSUE_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.issue-linked",
  "thread.issue-unlinked",
  "thread.issue-synced",
]);

export type ThreadIssueCommandFork = Extract<
  OrchestrationCommand,
  { type: "thread.issue.link" | "thread.issue.unlink" | "thread.issue-link.sync" }
>;

export type ThreadIssueEventFork = Extract<
  OrchestrationEvent,
  { type: "thread.issue-linked" | "thread.issue-unlinked" | "thread.issue-synced" }
>;

export const isThreadIssueCommandFork = (
  command: OrchestrationCommand,
): command is ThreadIssueCommandFork => THREAD_ISSUE_COMMAND_TYPES.has(command.type);

export const isThreadIssueEventFork = (event: OrchestrationEvent): event is ThreadIssueEventFork =>
  THREAD_ISSUE_EVENT_TYPES.has(event.type);

/** Issue keys share the pull request key normalization: host and repository lowercased. */
export const normalizeThreadIssueKey = (key: ThreadIssueKey): ThreadIssueKey =>
  normalizeThreadPullRequestKey({ host: key.host, repository: key.repository, number: key.number });

export const threadIssueKeysEqual = (left: ThreadIssueKey, right: ThreadIssueKey): boolean =>
  threadPullRequestKeysEqual(normalizeThreadIssueKey(left), normalizeThreadIssueKey(right));

const findIssueLink = (
  thread: Pick<OrchestrationThread, "issues">,
  key: ThreadIssueKey,
): ThreadIssueLink | undefined =>
  (thread.issues ?? []).find((link) => threadIssueKeysEqual(link, key));

/**
 * The thread's `issues` key: omitted when there are none, like a thread from
 * before links, so every projection serves a link-free thread unchanged.
 */
export const threadIssuesField = (
  issues: ReadonlyArray<ThreadIssueLink> | undefined,
): Pick<OrchestrationThread, "issues"> =>
  issues === undefined || issues.length === 0 ? {} : { issues };

const withIssues = (
  thread: OrchestrationThread,
  issues: ReadonlyArray<ThreadIssueLink>,
): OrchestrationThread => {
  const { issues: _previous, ...rest } = thread;
  return { ...rest, ...threadIssuesField(issues) };
};

/**
 * A snapshot read before the link existed describes an earlier link, and one
 * read before the stored snapshot lost a race to it; both are dropped.
 */
export const isStaleThreadIssueSync = (link: ThreadIssueLink, syncedAt: string): boolean =>
  compareDateTimeStrings(syncedAt, link.linkedAt) < 0 ||
  (link.snapshot !== null && compareDateTimeStrings(syncedAt, link.snapshot.syncedAt) < 0);

/** The slice of `decider.ts`'s local `withEventBase` these cases need. */
type WithEventBase = (input: {
  readonly aggregateKind: "thread";
  readonly aggregateId: OrchestrationEvent["aggregateId"];
  readonly occurredAt: string;
  readonly commandId: CommandId;
}) => Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
>;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const describeKey = (key: ThreadIssueKey) => `issue ${key.host}/${key.repository}#${key.number}`;

/**
 * Decides the issue link commands. A duplicate link, an unknown unlink, and a
 * stale sync are rejected: the engine refuses a zero-event command, so a no-op
 * surfaces as a rejection that leaves the projection unchanged.
 */
export const decideThreadIssueFork = Effect.fn("decideThreadIssueFork")(function* ({
  command,
  readModel,
  withEventBase,
}: {
  readonly command: ThreadIssueCommandFork;
  readonly readModel: OrchestrationReadModel;
  readonly withEventBase: WithEventBase;
}): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  const key = normalizeThreadIssueKey(command);
  const existing = findIssueLink(thread, key);
  const reject = (detail: string) =>
    new OrchestrationCommandInvariantError({ commandType: command.type, detail });
  const eventBase = (occurredAt: string) =>
    withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt,
      commandId: command.commandId,
    });

  switch (command.type) {
    case "thread.issue.link": {
      if (thread.deletedAt !== null) {
        return yield* reject(`thread ${command.threadId} is deleted`);
      }
      if (existing !== undefined) {
        return yield* reject(`${describeKey(key)} is already linked to thread ${command.threadId}`);
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* eventBase(occurredAt)),
        type: "thread.issue-linked",
        payload: {
          threadId: command.threadId,
          link: {
            ...key,
            url: command.url,
            source: command.source,
            linkedAt: occurredAt,
            snapshot: null,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.issue.unlink": {
      if (existing === undefined) {
        return yield* reject(`${describeKey(key)} is not linked to thread ${command.threadId}`);
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* eventBase(occurredAt)),
        type: "thread.issue-unlinked",
        payload: { threadId: command.threadId, ...key, updatedAt: occurredAt },
      };
    }

    case "thread.issue-link.sync": {
      if (existing === undefined) {
        return yield* reject(`${describeKey(key)} is not linked to thread ${command.threadId}`);
      }
      if (isStaleThreadIssueSync(existing, command.snapshot.syncedAt)) {
        return yield* reject(`${describeKey(key)} sync predates its link or its stored snapshot`);
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* eventBase(occurredAt)),
        type: "thread.issue-synced",
        payload: {
          threadId: command.threadId,
          ...key,
          snapshot: command.snapshot,
          updatedAt: occurredAt,
        },
      };
    }
  }
});

const patchThread = (
  model: OrchestrationReadModel,
  threadId: string,
  patch: (thread: OrchestrationThread) => OrchestrationThread | null,
): OrchestrationReadModel => {
  const index = model.threads.findIndex((thread) => thread.id === threadId);
  const thread = model.threads[index];
  if (thread === undefined) return model;
  const next = patch(thread);
  if (next === null) return model;
  const threads = model.threads.slice();
  threads[index] = next;
  return { ...model, threads };
};

const decodePayload = <A>(
  schema: Schema.Decoder<A, never>,
  payload: unknown,
  eventType: ThreadIssueEventFork["type"],
): Effect.Effect<A, OrchestrationProjectorDecodeError> =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:payload`)),
  );

/** Applies an issue link event to the in-memory read model. */
export const projectThreadIssueEventFork = (
  model: OrchestrationReadModel,
  event: ThreadIssueEventFork,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> => {
  switch (event.type) {
    case "thread.issue-linked":
      return decodePayload(ThreadIssueLinkedPayload, event.payload, event.type).pipe(
        Effect.map((payload) =>
          patchThread(model, payload.threadId, (thread) =>
            thread.deletedAt !== null
              ? null
              : {
                  ...withIssues(thread, [
                    ...(thread.issues ?? []).filter(
                      (link) => !threadIssueKeysEqual(link, payload.link),
                    ),
                    payload.link,
                  ]),
                  updatedAt: payload.updatedAt,
                },
          ),
        ),
      );

    case "thread.issue-unlinked":
      return decodePayload(ThreadIssueUnlinkedPayload, event.payload, event.type).pipe(
        Effect.map((payload) =>
          patchThread(model, payload.threadId, (thread) => ({
            ...withIssues(
              thread,
              (thread.issues ?? []).filter((link) => !threadIssueKeysEqual(link, payload)),
            ),
            updatedAt: payload.updatedAt,
          })),
        ),
      );

    case "thread.issue-synced":
      return decodePayload(ThreadIssueSyncedPayload, event.payload, event.type).pipe(
        Effect.map((payload) =>
          patchThread(model, payload.threadId, (thread) => {
            // A sync for a link removed in the meantime, or for an earlier link, is dropped.
            const link = findIssueLink(thread, payload);
            if (link === undefined || isStaleThreadIssueSync(link, payload.snapshot.syncedAt)) {
              return null;
            }
            return {
              ...withIssues(
                thread,
                (thread.issues ?? []).map((candidate) =>
                  candidate === link ? { ...candidate, snapshot: payload.snapshot } : candidate,
                ),
              ),
              updatedAt: payload.updatedAt,
            };
          }),
        ),
      );
  }
};

/**
 * Spread into the projector's `nextBase`: a deleted thread drops its issue
 * links, as the SQL projection deletes its rows. Empty for every other event.
 */
export const threadIssuesDroppedFork = (
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Partial<Pick<OrchestrationReadModel, "threads">> => {
  if (event.type !== "thread.deleted") return {};
  const { threads } = patchThread(model, event.payload.threadId, (thread) =>
    (thread.issues ?? []).length === 0 ? null : withIssues(thread, []),
  );
  return threads === model.threads ? {} : { threads };
};
