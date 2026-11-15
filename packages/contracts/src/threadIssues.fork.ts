// Fork-owned thread ↔ GitHub issue links, shaped like the pull request links in
// `orchestrationV2.ts`, which spreads these schemas in through marked hooks. Issue changes ride
// the upstream `thread.metadata-updated` event, whose payload is the whole thread, so the fork
// adds no event type an upstream client would reject.
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  IssueCloseReason,
  IssueLabel,
  IssueState,
  GitHubIssueType,
  GitHubSubIssue,
} from "./issue.ts";

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

/** An issue a thread can link: its host-level key and the address it opens at. */
export interface GitHubIssueLinkTarget extends ThreadIssueKey {
  readonly url: string;
}

/**
 * The link target an issue URL names, or null for anything that is not an issue page. The host
 * keeps a port, so an Enterprise install served on one stays a distinct host. It trusts any host;
 * a caller reading a URL it did not get from GitHub checks the host itself.
 */
export function githubIssueLinkTarget(url: string): GitHubIssueLinkTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(parsed.pathname);
  const number = Number(match?.[2]);
  if (!match?.[1] || !Number.isSafeInteger(number) || number < 1) return null;
  const host = parsed.host.toLowerCase();
  return {
    host,
    repository: match[1],
    number,
    url: `${parsed.protocol}//${host}/${match[1]}/issues/${number}`,
  };
}

/** Issue state last read from the host; null on a link until its first sync. */
export const ThreadIssueSnapshot = Schema.Struct({
  title: TrimmedNonEmptyString,
  state: IssueState,
  // Optional, not merely nullable: snapshot rows and events from an older server omit the key
  // entirely rather than sending null.
  closeReason: Schema.optional(Schema.NullOr(IssueCloseReason)),
  // Omitted when empty, so a bare issue keeps its earlier shape; an older snapshot omits them too.
  subIssues: Schema.optionalKey(Schema.Array(GitHubSubIssue)),
  parent: Schema.optionalKey(GitHubSubIssue),
  labels: Schema.optionalKey(Schema.Array(IssueLabel)),
  issueType: Schema.optionalKey(GitHubIssueType),
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

/**
 * An issue or pull request as a chat reference shows it. GitHub numbers both from one sequence,
 * so a bare `repo#N` resolves to whichever it is.
 */
export const GitHubReferenceSummary = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "closed", "not-planned", "draft", "merged"]),
  author: Schema.NullOr(
    Schema.Struct({ login: Schema.String, avatarUrl: Schema.NullOr(Schema.String) }),
  ),
  ownerAvatarUrl: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type GitHubReferenceSummary = typeof GitHubReferenceSummary.Type;
