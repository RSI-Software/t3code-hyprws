import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GUEST_MESSAGE_MAX_LENGTH } from "./guestShare.ts";

/** The whole grant a collaborator link pairs; the server narrows it further to shared threads. */
export const COLLABORATOR_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

/** A session holding exactly the collaborator grant: narrow by design, not a pre-scope leftover. */
export const isCollaboratorGrantFork = (
  permissions: ReadonlyArray<AuthEnvironmentScope> | undefined,
) =>
  permissions?.length === COLLABORATOR_SCOPES.length &&
  COLLABORATOR_SCOPES.every((scope) => permissions.includes(scope));

// A letter or digit keeps every name a distinct identity once punctuation folds away.
export const CollaboratorNameFork = TrimmedNonEmptyString.check(Schema.isPattern(/[\p{L}\p{N}]/u));

/** `send`: messages run as the host's would. `approve`: each waits for the host to send it. */
export const CollaboratorAccessFork = Schema.Literals(["send", "approve"]);
export type CollaboratorAccessFork = typeof CollaboratorAccessFork.Type;

export const CollaboratorShareThreadInputFork = Schema.Struct({
  threadId: ThreadId,
  collaboratorName: CollaboratorNameFork,
  /** Applies to this thread only; absent keeps a re-share's access, else `approve`. */
  access: Schema.optional(CollaboratorAccessFork),
  /** The origin the sharing client reached the server on; the link's base when public. */
  linkBaseUrl: Schema.optional(Schema.String),
});
export type CollaboratorShareThreadInputFork = typeof CollaboratorShareThreadInputFork.Type;

export const CollaboratorShareThreadResultFork = Schema.Struct({
  /** An https link when the server has a public address; its page offers the app or the browser. */
  pairingUrl: Schema.String,
  /** No public address was found, so the link reaches this server only from its own network. */
  localOnly: Schema.Boolean,
  /** The collaborator already had a share, so their paired app shows this thread without the link. */
  knownCollaborator: Schema.Boolean,
});
export type CollaboratorShareThreadResultFork = typeof CollaboratorShareThreadResultFork.Type;

export const CollaboratorFork = Schema.Struct({ subject: Schema.String, name: Schema.String });
export type CollaboratorFork = typeof CollaboratorFork.Type;

export const CollaboratorShareFork = Schema.Struct({
  ...CollaboratorFork.fields,
  access: CollaboratorAccessFork,
});
export type CollaboratorShareFork = typeof CollaboratorShareFork.Type;

export const CollaboratorThreadSharesInputFork = Schema.Struct({ threadId: ThreadId });

export const CollaboratorThreadSharesResultFork = Schema.Struct({
  sharedWith: Schema.Array(CollaboratorShareFork),
  collaborators: Schema.Array(CollaboratorFork),
});
export type CollaboratorThreadSharesResultFork = typeof CollaboratorThreadSharesResultFork.Type;

export const CollaboratorUnshareThreadInputFork = Schema.Struct({
  threadId: ThreadId,
  subject: Schema.String,
});
export type CollaboratorUnshareThreadInputFork = typeof CollaboratorUnshareThreadInputFork.Type;

export const CollaboratorSetAccessInputFork = Schema.Struct({
  ...CollaboratorUnshareThreadInputFork.fields,
  access: CollaboratorAccessFork,
});
export type CollaboratorSetAccessInputFork = typeof CollaboratorSetAccessInputFork.Type;

/** A collaborator's message waiting for the host to send or dismiss it. */
export const CollaboratorMessageFork = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  subject: Schema.String,
  name: Schema.String,
  text: Schema.String,
  submittedAt: IsoDateTime,
});
export type CollaboratorMessageFork = typeof CollaboratorMessageFork.Type;

export const CollaboratorSubmitMessageInputFork = Schema.Struct({
  threadId: ThreadId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(GUEST_MESSAGE_MAX_LENGTH)),
});
export type CollaboratorSubmitMessageInputFork = typeof CollaboratorSubmitMessageInputFork.Type;

/** The host sends or dismisses; a collaborator may only dismiss, withdrawing their own. */
export const CollaboratorResolveMessageInputFork = Schema.Struct({
  threadId: ThreadId,
  messageId: TrimmedNonEmptyString,
  decision: Schema.Literals(["send", "dismiss"]),
});
export type CollaboratorResolveMessageInputFork = typeof CollaboratorResolveMessageInputFork.Type;

/** Who wrote a user message the host's agent got from a collaborator. Only the server sets it. */
export const CollaboratorAttributionFork = Schema.Struct({
  name: Schema.String,
  /** The collaborator's own words; the message text carries the attributed form the agent reads. */
  text: Schema.String,
});
export type CollaboratorAttributionFork = typeof CollaboratorAttributionFork.Type;

export class CollaboratorThreadMissingErrorFork extends Schema.TaggedError<CollaboratorThreadMissingErrorFork>()(
  "CollaboratorThreadMissingErrorFork",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This thread no longer exists.";
  }
}

export class CollaboratorShareErrorFork extends Schema.TaggedError<CollaboratorShareErrorFork>()(
  "CollaboratorShareErrorFork",
  {
    operation: Schema.Literals(["read-thread", "pair", "record-share", "read-shares"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not share the thread.";
  }
}

export class CollaboratorUnshareErrorFork extends Schema.TaggedError<CollaboratorUnshareErrorFork>()(
  "CollaboratorUnshareErrorFork",
  {
    operation: Schema.Literals(["freeze-share", "read-shares"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not stop sharing.";
  }
}

export class CollaboratorAccessErrorFork extends Schema.TaggedError<CollaboratorAccessErrorFork>()(
  "CollaboratorAccessErrorFork",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change access.";
  }
}

export class CollaboratorMessageMissingErrorFork extends Schema.TaggedError<CollaboratorMessageMissingErrorFork>()(
  "CollaboratorMessageMissingErrorFork",
  { messageId: Schema.String },
) {
  override get message(): string {
    return "That message was already sent or dismissed.";
  }
}

export class CollaboratorMessageBusyErrorFork extends Schema.TaggedError<CollaboratorMessageBusyErrorFork>()(
  "CollaboratorMessageBusyErrorFork",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Wait for the host to answer your earlier messages.";
  }
}

export class CollaboratorMessageDeliveryErrorFork extends Schema.TaggedError<CollaboratorMessageDeliveryErrorFork>()(
  "CollaboratorMessageDeliveryErrorFork",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not deliver the message.";
  }
}

export const CollaboratorMessageErrorFork = Schema.Union([
  CollaboratorMessageMissingErrorFork,
  CollaboratorMessageBusyErrorFork,
  CollaboratorMessageDeliveryErrorFork,
]);
export type CollaboratorMessageErrorFork = typeof CollaboratorMessageErrorFork.Type;

/** Query param on a `t3code://pair` link naming the thread to open after pairing. */
export const COLLABORATOR_THREAD_LINK_PARAM = "thread";
