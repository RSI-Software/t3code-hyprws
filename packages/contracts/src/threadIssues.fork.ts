// Fork-owned thread ↔ GitHub issue links (RSI-Software/t3code-hyprws#1431), shaped
// like the thread ↔ pull request links in `orchestrationV2.ts`. That upstream file
// carries only marked hooks that spread the schemas below into its app thread,
// thread shell and command unions. Issue changes ride the upstream
// `thread.metadata-updated` event, whose payload is the whole thread, so the fork
// adds no event type an upstream client would reject.
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

/** Spread into both client command unions. */
export const threadIssueClientCommandsFork = [
  ThreadIssueLinkCommand,
  ThreadIssueUnlinkCommand,
] as const;

/** Spread into the internal command union: only the server reads issue state. */
export const threadIssueInternalCommandsFork = [ThreadIssueLinkSyncCommand] as const;
