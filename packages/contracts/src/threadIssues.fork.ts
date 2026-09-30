// Fork-owned thread ↔ GitHub issue links (RSI-Software/t3code-hyprws#1431), shaped
// like the thread ↔ pull request links in `orchestration.ts`. That upstream file
// carries only marked hooks that spread the schemas below into its thread read
// model, command unions, event-type literals and event union.
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { GitHubIssueState } from "./githubIssue.ts";

/** Who created a thread ↔ issue link. */
export const ThreadIssueLinkSource = Schema.Literals(["manual", "handoff", "agent"]);
export type ThreadIssueLinkSource = typeof ThreadIssueLinkSource.Type;

/** Host-level identity, so one issue linked from two projects compares equal. */
export const ThreadIssueKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadIssueKey = typeof ThreadIssueKey.Type;

/** Issue state last read from the host; null on a link until its first sync. */
export const ThreadIssueSnapshot = Schema.Struct({
  title: TrimmedNonEmptyString,
  state: GitHubIssueState,
  syncedAt: IsoDateTime,
});
export type ThreadIssueSnapshot = typeof ThreadIssueSnapshot.Type;

export const ThreadIssueLink = Schema.Struct({
  ...ThreadIssueKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadIssueLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadIssueSnapshot),
});
export type ThreadIssueLink = typeof ThreadIssueLink.Type;

/**
 * The thread's `issues` field. The server omits the key when a thread has no
 * links, so a thread without links keeps its pre-feature shape on the wire and
 * a payload from a server without links decodes unchanged. Readers treat a
 * missing key as no links: `thread.issues ?? []`.
 */
export const ThreadIssueLinksFieldFork = Schema.optionalKey(Schema.Array(ThreadIssueLink));

const ThreadIssueLinkCommand = Schema.Struct({
  type: Schema.Literal("thread.issue.link"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadIssueKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadIssueLinkSource,
});

const ThreadIssueUnlinkCommand = Schema.Struct({
  type: Schema.Literal("thread.issue.unlink"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadIssueKey.fields,
});

const ThreadIssueLinkSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.issue-link.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  ...ThreadIssueKey.fields,
  snapshot: ThreadIssueSnapshot,
});

/**
 * Which of a thread's links to reread from the host: `stale` for a panel opening
 * (unread or older than the server's freshness window), `all` for a refresh.
 */
export const ThreadIssueSyncScope = Schema.Literals(["stale", "all"]);
export type ThreadIssueSyncScope = typeof ThreadIssueSyncScope.Type;

export const ThreadIssueSyncInput = Schema.Struct({
  threadId: ThreadId,
  scope: ThreadIssueSyncScope,
});
export type ThreadIssueSyncInput = typeof ThreadIssueSyncInput.Type;

/** Spread into both client command unions. */
export const threadIssueClientCommandsFork = [
  ThreadIssueLinkCommand,
  ThreadIssueUnlinkCommand,
] as const;

/** Spread into the internal command union: only the server reads issue state. */
export const threadIssueInternalCommandsFork = [ThreadIssueLinkSyncCommand] as const;

export const ThreadIssueLinkedPayload = Schema.Struct({
  threadId: ThreadId,
  link: ThreadIssueLink,
  updatedAt: IsoDateTime,
});
export type ThreadIssueLinkedPayload = typeof ThreadIssueLinkedPayload.Type;

export const ThreadIssueUnlinkedPayload = Schema.Struct({
  threadId: ThreadId,
  ...ThreadIssueKey.fields,
  updatedAt: IsoDateTime,
});
export type ThreadIssueUnlinkedPayload = typeof ThreadIssueUnlinkedPayload.Type;

export const ThreadIssueSyncedPayload = Schema.Struct({
  threadId: ThreadId,
  ...ThreadIssueKey.fields,
  snapshot: ThreadIssueSnapshot,
  updatedAt: IsoDateTime,
});
export type ThreadIssueSyncedPayload = typeof ThreadIssueSyncedPayload.Type;

/** Spread into `OrchestrationEventType`. */
export const THREAD_ISSUE_EVENT_TYPES_FORK = [
  "thread.issue-linked",
  "thread.issue-unlinked",
  "thread.issue-synced",
] as const;

/**
 * The event structs, built over the upstream event base fields passed in, so
 * this sibling never imports `orchestration.ts` back. Spread into
 * `OrchestrationEvent`.
 */
export const threadIssueEventsFork = <const Base extends Schema.Struct.Fields>(base: Base) =>
  [
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.issue-linked"),
      payload: ThreadIssueLinkedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.issue-unlinked"),
      payload: ThreadIssueUnlinkedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.issue-synced"),
      payload: ThreadIssueSyncedPayload,
    }),
  ] as const;
