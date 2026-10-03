// Fork-only: pull-request attachment RPC registrations for commit `1314ebcb28`
// (fix(web): upload media in pull request descriptions). The upstream `rpc.ts`
// carries only marked spread/import hooks pointing here, per the side-table +
// spread precedent (`environment.fork.ts`). The method-name strings live here
// rather than referencing `WS_METHODS`, because importing `rpc.ts` from a
// top-level sibling would read `WS_METHODS` before its initialisation.
import * as Rpc from "effect/unstable/rpc/Rpc";
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
  GitHubIssueDetail,
  GitHubIssueListInput,
  GitHubIssueListResult,
  GitHubIssueOperationError,
  GitHubIssueRef,
  GitHubIssueSetStateInput,
} from "./githubIssue.ts";
import { PullRequestLinkedThreadsResult } from "./pullRequest.ts";
import { ThreadIssueKey, ThreadIssueSyncInput } from "./threadIssues.fork.ts";

const GitHubIssueRpcErrorFork = Schema.Union([
  GitHubIssueCliMissingError,
  GitHubIssueCliUnauthenticatedError,
  GitHubIssueOperationError,
  EnvironmentAuthorizationError,
]);

const WsGitHubIssuesListRpcFork = Rpc.make("githubIssues.list", {
  payload: GitHubIssueListInput,
  success: GitHubIssueListResult,
  error: GitHubIssueRpcErrorFork,
});

const WsGitHubIssuesDetailRpcFork = Rpc.make("githubIssues.detail", {
  payload: GitHubIssueRef,
  success: GitHubIssueDetail,
  error: GitHubIssueRpcErrorFork,
});

/** Threads linked to one issue, by host-qualified key (RSI-Software/t3code-hyprws#1431). */
const WsGitHubIssuesLinkedThreadsRpcFork = Rpc.make("githubIssues.linkedThreads", {
  payload: ThreadIssueKey,
  success: PullRequestLinkedThreadsResult,
  error: GitHubIssueRpcErrorFork,
});

const WsGitHubIssuesSetStateRpcFork = Rpc.make("githubIssues.setState", {
  payload: GitHubIssueSetStateInput,
  error: GitHubIssueRpcErrorFork,
});

/**
 * Rereads a thread's linked issues from GitHub (RSI-Software/t3code-hyprws#1434). Answers once
 * the reads are queued; the snapshots arrive on the thread shell stream.
 */
const WsGitHubIssuesSyncThreadLinksRpcFork = Rpc.make("githubIssues.syncThreadLinks", {
  payload: ThreadIssueSyncInput,
  error: GitHubIssueRpcErrorFork,
});

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`github-issues/rpc-methods`, `github-issues/rpc-group`).
 */
export const githubIssuesRpcFork = {
  methodNames: {
    githubIssuesList: "githubIssues.list",
    githubIssuesDetail: "githubIssues.detail",
    githubIssuesLinkedThreads: "githubIssues.linkedThreads",
    githubIssuesSetState: "githubIssues.setState",
    githubIssuesSyncThreadLinks: "githubIssues.syncThreadLinks",
  } as const,
  rpcs: [
    WsGitHubIssuesListRpcFork,
    WsGitHubIssuesDetailRpcFork,
    WsGitHubIssuesLinkedThreadsRpcFork,
    WsGitHubIssuesSetStateRpcFork,
    WsGitHubIssuesSyncThreadLinksRpcFork,
  ] as const,
};
