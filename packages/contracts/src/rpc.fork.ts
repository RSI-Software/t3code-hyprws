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
} from "./githubIssue.ts";
import { PullRequestLinkedThreadsResult } from "./pullRequest.ts";
import { ThreadIssueKey } from "./threadIssues.fork.ts";

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

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`github-issues/rpc-methods`, `github-issues/rpc-group`).
 */
export const githubIssuesRpcFork = {
  methodNames: {
    githubIssuesList: "githubIssues.list",
    githubIssuesDetail: "githubIssues.detail",
    githubIssuesLinkedThreads: "githubIssues.linkedThreads",
  } as const,
  rpcs: [
    WsGitHubIssuesListRpcFork,
    WsGitHubIssuesDetailRpcFork,
    WsGitHubIssuesLinkedThreadsRpcFork,
  ] as const,
};

// Fork-thread RPC registration for the same-provider thread fork. The payload,
// result, and refusal errors live in `threadFork.fork.ts`; the handler and its
// guards live in `apps/server/src/project/ThreadFork.fork.ts`.
import { EnvironmentAuthorizationError as ThreadForkEnvironmentAuthorizationError } from "./auth.ts";
import { ThreadForkError, ThreadForkInput, ThreadForkResult } from "./threadFork.fork.ts";

const ThreadForkRpcErrorFork = Schema.Union([
  ThreadForkError,
  ThreadForkEnvironmentAuthorizationError,
]);

const WsThreadForkRpcFork = Rpc.make("thread.fork", {
  payload: ThreadForkInput,
  success: ThreadForkResult,
  error: ThreadForkRpcErrorFork,
});

/**
 * Spread into the upstream `WS_METHODS` collection and `WsRpcGroup` through the
 * marked hooks in `rpc.ts` (`thread-fork/rpc-methods`, `thread-fork/rpc-group`).
 */
export const threadForkRpcFork = {
  methodNames: {
    threadFork: "thread.fork",
  } as const,
  rpcs: [WsThreadForkRpcFork] as const,
};
