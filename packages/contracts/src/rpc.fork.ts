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
