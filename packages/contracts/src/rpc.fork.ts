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

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { IssueOperationError, IssueRef, IssueSummary, IssueUnavailableError } from "./issue.ts";

/** A chat chip's title and state; the server batches every chip's read into one tracker call. */
export const issueSummaryRpcFork = {
  methodNames: { issuesSummaryFork: "issues.summaryFork" } as const,
  rpcs: [
    Rpc.make("issues.summaryFork", {
      payload: IssueRef,
      success: IssueSummary,
      error: Schema.Union([
        IssueUnavailableError,
        IssueOperationError,
        EnvironmentAuthorizationError,
      ]),
    }),
  ] as const,
};

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
  CollaboratorSetTypingInputFork,
  CollaboratorSubmitMessageInputFork,
  CollaboratorShareErrorFork,
  CollaboratorShareThreadInputFork,
  CollaboratorShareThreadResultFork,
  CollaboratorThreadSharesInputFork,
  CollaboratorThreadMissingErrorFork,
  CollaboratorThreadSharesResultFork,
  CollaboratorTypingStateFork,
  CollaboratorUnshareErrorFork,
  CollaboratorUnshareThreadInputFork,
  ColleagueClientPairingFork,
  ColleagueConnectInputFork,
  ColleagueErrorFork,
  ColleagueFork,
  ColleagueForkThreadErrorFork,
  ColleagueForkThreadInputFork,
  ColleagueGrantFork,
  ColleagueInviteInputFork,
  ColleagueInviteLinkInputFork,
  ColleagueInviteLinkResultFork,
  ColleagueQueuedMessageFork,
  ColleagueQueueMessageInputFork,
  ColleagueRemoveResultFork,
  ColleagueSaveInputFork,
  ColleagueSaveResultFork,
  ColleagueShareThreadInputFork,
  ColleagueSubjectInputFork,
  ColleagueUnqueueMessageInputFork,
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
    collaboratorSetTypingFork: "collaborator.setTypingFork",
    collaboratorSubscribeTypingFork: "collaborator.subscribeTypingFork",
    colleagueInviteFork: "colleague.inviteFork",
    colleagueInviteLinkFork: "colleague.inviteLinkFork",
    colleagueSaveFork: "colleague.saveFork",
    colleagueConnectFork: "colleague.connectFork",
    colleagueSubscribeFork: "colleague.subscribeFork",
    colleagueRemoveFork: "colleague.removeFork",
    colleaguePairClientFork: "colleague.pairClientFork",
    colleagueShareThreadFork: "colleague.shareThreadFork",
    colleagueSubscribeOutboxFork: "colleague.subscribeOutboxFork",
    colleagueQueueMessageFork: "colleague.queueMessageFork",
    colleagueUnqueueMessageFork: "colleague.unqueueMessageFork",
    colleagueForkThreadFork: "colleague.forkThreadFork",
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
    Rpc.make("collaborator.setTypingFork", {
      payload: CollaboratorSetTypingInputFork,
      error: EnvironmentAuthorizationError,
    }),
    // Whether the thread is shared, and who else types in it; every host session is typist `host`.
    Rpc.make("collaborator.subscribeTypingFork", {
      payload: Schema.Struct({ threadId: ThreadId }),
      success: CollaboratorTypingStateFork,
      error: EnvironmentAuthorizationError,
      stream: true,
    }),
    // Saved colleagues: accepting an invite runs invite (own server), save (the sharer's, as the
    // collaborator), then connect (own server). See `docs/fork/user/collaborator-sharing.md`.
    Rpc.make("colleague.inviteFork", {
      payload: ColleagueInviteInputFork,
      success: ColleagueGrantFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    // A colleague-only link: accepting it runs the three steps above and shares no thread.
    Rpc.make("colleague.inviteLinkFork", {
      payload: ColleagueInviteLinkInputFork,
      success: ColleagueInviteLinkResultFork,
      error: Schema.Union([CollaboratorShareErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("colleague.saveFork", {
      payload: ColleagueSaveInputFork,
      success: ColleagueSaveResultFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("colleague.connectFork", {
      payload: ColleagueConnectInputFork,
      success: ColleagueFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("colleague.subscribeFork", {
      payload: Schema.Struct({}),
      success: Schema.Array(ColleagueFork),
      error: EnvironmentAuthorizationError,
      stream: true,
    }),
    Rpc.make("colleague.removeFork", {
      payload: ColleagueSubjectInputFork,
      success: ColleagueRemoveResultFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("colleague.pairClientFork", {
      payload: ColleagueSubjectInputFork,
      success: ColleagueClientPairingFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("colleague.shareThreadFork", {
      payload: ColleagueShareThreadInputFork,
      error: Schema.Union([
        ColleagueErrorFork,
        CollaboratorShareErrorFork,
        CollaboratorThreadMissingErrorFork,
        EnvironmentAuthorizationError,
      ]),
    }),
    // Messages for colleagues' threads, waiting on this server while their machine is offline.
    Rpc.make("colleague.subscribeOutboxFork", {
      payload: Schema.Struct({}),
      success: Schema.Array(ColleagueQueuedMessageFork),
      error: EnvironmentAuthorizationError,
      stream: true,
    }),
    Rpc.make("colleague.queueMessageFork", {
      payload: ColleagueQueueMessageInputFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    Rpc.make("colleague.unqueueMessageFork", {
      payload: ColleagueUnqueueMessageInputFork,
      error: Schema.Union([ColleagueErrorFork, EnvironmentAuthorizationError]),
    }),
    // Forks a colleague's thread, from this client's copy of it, into a project on this server.
    Rpc.make("colleague.forkThreadFork", {
      payload: ColleagueForkThreadInputFork,
      error: Schema.Union([ColleagueForkThreadErrorFork, EnvironmentAuthorizationError]),
    }),
  ] as const,
};

/** Every fork WS RPC; the server serves them from a handler layer of their own. */
export const wsRpcsFork = [
  ...pullRequestAttachmentRpcFork.rpcs,
  ...pullRequestActivityRpcFork.rpcs,
  ...issueSummaryRpcFork.rpcs,
  ...threadGroupsRpcFork.rpcs,
  ...collaboratorRpcFork.rpcs,
] as const;
