// Fork-only: pull-request attachment RPC registrations, spread into upstream `rpc.ts` through
// marked hooks. The method names are literals rather than `WS_METHODS`, because importing
// `rpc.ts` from a top-level sibling would read `WS_METHODS` before its initialisation.
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AttachmentCreateUploadUrlResult } from "./assets.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  PullRequestAttachmentCreateUploadUrlInput,
  PullRequestAttachmentUploadInput,
  PullRequestAttachmentUploadResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";

import { NonNegativeInt } from "./baseSchemas.ts";

/** Activity readers observe edits without subscribing to turn-only revisions. */
export const pullRequestActivityRpcFork = {
  methodNames: {
    pullRequestsSubscribeActivityRefreshesFork: "pullRequests.subscribeActivityRefreshesFork",
  } as const,
  rpcs: [
    Rpc.make("pullRequests.subscribeActivityRefreshesFork", {
      payload: Schema.Struct({}),
      success: NonNegativeInt,
      error: EnvironmentAuthorizationError,
      stream: true,
    }),
  ] as const,
};

const PullRequestAttachmentRpcErrorFork = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

const WsPullRequestsCreateAttachmentUploadUrlRpcFork = Rpc.make(
  "pullRequests.createAttachmentUploadUrl",
  {
    payload: PullRequestAttachmentCreateUploadUrlInput,
    success: AttachmentCreateUploadUrlResult,
    error: PullRequestAttachmentRpcErrorFork,
  },
);

const WsPullRequestsUploadAttachmentRpcFork = Rpc.make("pullRequests.uploadAttachment", {
  payload: PullRequestAttachmentUploadInput,
  success: PullRequestAttachmentUploadResult,
  error: PullRequestAttachmentRpcErrorFork,
});

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`upstream-fixes/pr-attachment-rpc-*`).
 */
export const pullRequestAttachmentRpcFork = {
  methodNames: {
    pullRequestsCreateAttachmentUploadUrl: "pullRequests.createAttachmentUploadUrl",
    pullRequestsUploadAttachment: "pullRequests.uploadAttachment",
  } as const,
  rpcs: [
    WsPullRequestsCreateAttachmentUploadUrlRpcFork,
    WsPullRequestsUploadAttachmentRpcFork,
  ] as const,
};

// GitHub issue RPC registrations for commit `9f92309411` (feat(issues): add
// GitHub Issues surface scoped to project windows), folded into this shared
// sibling on RSI-Software/t3code-hyprws#959.
import {
  GitHubIssueCliMissingError,
  GitHubIssueCliUnauthenticatedError,
  IssueDetail,
  IssueListInput,
  IssueListResult,
  GitHubIssueOperationError,
  IssueRef,
  IssueSetStateInput,
} from "./issue.ts";
import { PullRequestLinkedThreadsResult } from "./pullRequest.ts";
import {
  GitHubReferenceSummary,
  ThreadIssueKey,
  ThreadIssueSyncInput,
} from "./threadIssues.fork.ts";

const IssueRpcErrorFork = Schema.Union([
  GitHubIssueCliMissingError,
  GitHubIssueCliUnauthenticatedError,
  GitHubIssueOperationError,
  EnvironmentAuthorizationError,
]);

const WsIssuesListRpcFork = Rpc.make("githubIssues.list", {
  payload: IssueListInput,
  success: IssueListResult,
  error: IssueRpcErrorFork,
});

const WsIssuesDetailRpcFork = Rpc.make("githubIssues.detail", {
  payload: IssueRef,
  success: IssueDetail,
  error: IssueRpcErrorFork,
});

/** Threads linked to one issue, by host-qualified key (RSI-Software/t3code-hyprws#1431). */
const WsIssuesLinkedThreadsRpcFork = Rpc.make("githubIssues.linkedThreads", {
  payload: ThreadIssueKey,
  success: PullRequestLinkedThreadsResult,
  error: IssueRpcErrorFork,
});

/** Title and state of the issue or pull request a chat reference names; null when it is gone. */
const WsIssuesReferenceRpcFork = Rpc.make("githubIssues.reference", {
  payload: ThreadIssueKey,
  success: Schema.NullOr(GitHubReferenceSummary),
  error: IssueRpcErrorFork,
});

const WsIssuesSetStateRpcFork = Rpc.make("githubIssues.setState", {
  payload: IssueSetStateInput,
  error: IssueRpcErrorFork,
});

/**
 * Rereads a thread's linked issues from GitHub (RSI-Software/t3code-hyprws#1434). Answers once
 * the reads are queued; the snapshots arrive on the thread shell stream.
 */
const WsIssuesSyncThreadLinksRpcFork = Rpc.make("githubIssues.syncThreadLinks", {
  payload: ThreadIssueSyncInput,
  error: IssueRpcErrorFork,
});

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`github-issues/rpc-methods`, `github-issues/rpc-group`).
 */
export const issuesRpcFork = {
  methodNames: {
    issuesList: "githubIssues.list",
    issuesDetail: "githubIssues.detail",
    issuesLinkedThreads: "githubIssues.linkedThreads",
    issuesReference: "githubIssues.reference",
    issuesSetState: "githubIssues.setState",
    issuesSyncThreadLinks: "githubIssues.syncThreadLinks",
  } as const,
  rpcs: [
    WsIssuesListRpcFork,
    WsIssuesDetailRpcFork,
    WsIssuesLinkedThreadsRpcFork,
    WsIssuesReferenceRpcFork,
    WsIssuesSetStateRpcFork,
    WsIssuesSyncThreadLinksRpcFork,
  ] as const,
};

// Thread checkout move (zmux-estate): the request, result, and refusal live in
// `checkoutMove.ts`; the handler lives in
// `apps/server/src/git/CheckoutMoveService.fork.ts`.
import {
  ThreadCheckoutMoveError,
  ThreadCheckoutMoveRequestInput,
  ThreadCheckoutMoveRequestResult,
} from "./checkoutMove.ts";

const WsThreadCheckoutMoveRequestRpcFork = Rpc.make("thread.checkoutMove.request", {
  payload: ThreadCheckoutMoveRequestInput,
  success: ThreadCheckoutMoveRequestResult,
  error: Schema.Union([ThreadCheckoutMoveError, EnvironmentAuthorizationError]),
});

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`zmux-estate/checkout-move-rpc-*`).
 */
export const checkoutMoveRpcFork = {
  methodNames: {
    threadCheckoutMoveRequest: "thread.checkoutMove.request",
  } as const,
  rpcs: [WsThreadCheckoutMoveRequestRpcFork] as const,
};

// Server-side sidebar thread groups (thread-ordering); the schemas and the one
// mutation reducer live in `threadGroups.fork.ts`.
import {
  ThreadGroupErrorFork,
  ThreadGroupMutationFork,
  ThreadGroupsSnapshotFork,
} from "./threadGroups.fork.ts";

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`thread-ordering/thread-groups-rpc-*`).
 */
export const threadGroupsRpcFork = {
  methodNames: {
    threadGroupsSubscribeFork: "threadGroups.subscribeFork",
    threadGroupsMutateFork: "threadGroups.mutateFork",
  } as const,
  rpcs: [
    Rpc.make("threadGroups.subscribeFork", {
      payload: Schema.Struct({}),
      success: ThreadGroupsSnapshotFork,
      error: EnvironmentAuthorizationError,
      stream: true,
    }),
    Rpc.make("threadGroups.mutateFork", {
      payload: ThreadGroupMutationFork,
      success: ThreadGroupsSnapshotFork,
      error: Schema.Union([ThreadGroupErrorFork, EnvironmentAuthorizationError]),
    }),
  ] as const,
};

// Collaborators (colleague-collab): share one thread through a pairing link.
import {
  CollaboratorAccessErrorFork,
  CollaboratorMessageErrorFork,
  CollaboratorMessageFork,
  CollaboratorResolveMessageInputFork,
  CollaboratorSetAccessInputFork,
  CollaboratorSubmitMessageInputFork,
  CollaboratorShareErrorFork,
  CollaboratorShareThreadInputFork,
  CollaboratorShareThreadResultFork,
  CollaboratorThreadSharesInputFork,
  CollaboratorThreadMissingErrorFork,
  CollaboratorThreadSharesResultFork,
  CollaboratorUnshareErrorFork,
  CollaboratorUnshareThreadInputFork,
} from "./collaborator.fork.ts";

export const collaboratorRpcFork = {
  methodNames: {
    collaboratorShareThreadFork: "collaborator.shareThreadFork",
    collaboratorThreadSharesFork: "collaborator.threadSharesFork",
    collaboratorUnshareThreadFork: "collaborator.unshareThreadFork",
    collaboratorSetAccessFork: "collaborator.setAccessFork",
    collaboratorSubscribeMessagesFork: "collaborator.subscribeMessagesFork",
    collaboratorSubmitMessageFork: "collaborator.submitMessageFork",
    collaboratorResolveMessageFork: "collaborator.resolveMessageFork",
  } as const,
  rpcs: [
    Rpc.make("collaborator.shareThreadFork", {
      payload: CollaboratorShareThreadInputFork,
      success: CollaboratorShareThreadResultFork,
      error: Schema.Union([
        CollaboratorShareErrorFork,
        CollaboratorThreadMissingErrorFork,
        EnvironmentAuthorizationError,
      ]),
    }),
    Rpc.make("collaborator.threadSharesFork", {
      payload: CollaboratorThreadSharesInputFork,
      success: CollaboratorThreadSharesResultFork,
    }),
    Rpc.make("collaborator.unshareThreadFork", {
      payload: CollaboratorUnshareThreadInputFork,
      error: Schema.Union([CollaboratorUnshareErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("collaborator.setAccessFork", {
      payload: CollaboratorSetAccessInputFork,
      error: Schema.Union([CollaboratorAccessErrorFork, EnvironmentAuthorizationError]),
    }),
    // Every waiting message this session may see: all of them for the host, its own for a
    // collaborator.
    Rpc.make("collaborator.subscribeMessagesFork", {
      payload: Schema.Struct({}),
      success: Schema.Array(CollaboratorMessageFork),
      error: EnvironmentAuthorizationError,
      stream: true,
    }),
    Rpc.make("collaborator.submitMessageFork", {
      payload: CollaboratorSubmitMessageInputFork,
      error: Schema.Union([CollaboratorMessageErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("collaborator.resolveMessageFork", {
      payload: CollaboratorResolveMessageInputFork,
      error: Schema.Union([CollaboratorMessageErrorFork, EnvironmentAuthorizationError]),
    }),
  ] as const,
};

/** Every fork WS RPC; the server serves them from a handler layer of their own. */
export const wsRpcsFork = [
  ...pullRequestAttachmentRpcFork.rpcs,
  ...pullRequestActivityRpcFork.rpcs,
  ...issuesRpcFork.rpcs,
  ...checkoutMoveRpcFork.rpcs,
  ...threadGroupsRpcFork.rpcs,
  ...collaboratorRpcFork.rpcs,
] as const;
