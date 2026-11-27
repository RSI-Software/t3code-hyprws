import * as Schema from "effect/Schema";

import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { AssistantCitation } from "./assistantCitations.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";

/** The whole grant a collaborator link pairs; the server narrows it further to shared threads. */
export const COLLABORATOR_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

/** Sharing or widening a share hands that grant out, so the sharer must hold it, as for a pairing link. */
export const COLLABORATOR_SHARE_SCOPES = [AuthAccessWriteScope, ...COLLABORATOR_SCOPES];

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
  /** The name the share went to: a known collaborator's saved spelling, else the name as typed. */
  collaboratorName: Schema.String,
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

/** A collaborator's message waiting for the host, or one the host dismissed, until its author clears it. */
export const CollaboratorMessageFork = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  subject: Schema.String,
  name: Schema.String,
  text: Schema.String,
  submittedAt: IsoDateTime,
  outcome: Schema.optional(Schema.Literal("dismissed")),
  /** "Ask the agent": once the host sends it, the agent answers it. */
  forceReplyFork: Schema.optional(Schema.Literal(true)),
});
export type CollaboratorMessageFork = typeof CollaboratorMessageFork.Type;

// As long as the host may send, less room for the attribution the agent reads with it.
const COLLABORATOR_MESSAGE_MAX_LENGTH = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 1_000;

const CollaboratorMessageText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COLLABORATOR_MESSAGE_MAX_LENGTH),
);

export const CollaboratorSubmitMessageInputFork = Schema.Struct({
  threadId: ThreadId,
  text: CollaboratorMessageText,
  /** Set by a flush from the sender's queue, so a repeat delivery waits once. */
  id: Schema.optional(TrimmedNonEmptyString),
  forceReplyFork: Schema.optional(Schema.Literal(true)),
});
export type CollaboratorSubmitMessageInputFork = typeof CollaboratorSubmitMessageInputFork.Type;

/** The host sends or dismisses; a collaborator may only dismiss, withdrawing or clearing their own. */
export const CollaboratorResolveMessageInputFork = Schema.Struct({
  threadId: ThreadId,
  messageId: TrimmedNonEmptyString,
  decision: Schema.Literals(["send", "dismiss"]),
});
export type CollaboratorResolveMessageInputFork = typeof CollaboratorResolveMessageInputFork.Type;

export const COLLABORATOR_DRAFT_TEXT_MAX_CHARS = 4_000;
export const COLLABORATOR_DRAFT_CHIPS_MAX = 20;
// Matches composer context labels; `composerContext.ts` imports this file, so it cannot be shared.
const COLLABORATOR_DRAFT_CHIP_LABEL_MAX_CHARS = 200;

/** A read-only copy of an unsent draft: its text, and a kind and label for each context in it. */
export const CollaboratorDraftFork = Schema.Struct({
  /** The draft's end when it runs past the cap, the part the writer is working on. */
  text: Schema.String.check(Schema.isMaxLength(COLLABORATOR_DRAFT_TEXT_MAX_CHARS)),
  truncated: Schema.Boolean,
  chips: Schema.Array(
    Schema.Struct({
      kind: Schema.String.check(Schema.isMaxLength(40)),
      label: Schema.String.check(Schema.isMaxLength(COLLABORATOR_DRAFT_CHIP_LABEL_MAX_CHARS)),
    }),
  ).check(Schema.isMaxLength(COLLABORATOR_DRAFT_CHIPS_MAX)),
  /** Where `text` holds a context's generated label, so others can show it in their language. */
  inline: Schema.optional(
    Schema.Array(
      Schema.Struct({
        start: NonNegativeInt,
        end: NonNegativeInt,
        kind: Schema.String.check(Schema.isMaxLength(40)),
      }),
    ).check(Schema.isMaxLength(COLLABORATOR_DRAFT_CHIPS_MAX)),
  ),
  /** Passages of this thread the draft cites, so others see them marked inline. */
  citations: Schema.optional(
    Schema.Array(AssistantCitation).check(Schema.isMaxLength(COLLABORATOR_DRAFT_CHIPS_MAX)),
  ),
});
export type CollaboratorDraftFork = typeof CollaboratorDraftFork.Type;

/** Someone writing in a shared thread's composer: a collaborator, or the host, who has no name. */
export const CollaboratorTypistFork = Schema.Struct({
  subject: Schema.String,
  name: Schema.optional(Schema.String),
  /** Absent from an older client, which shows only that they are typing. */
  draft: Schema.optional(CollaboratorDraftFork),
  device: Schema.optional(Schema.String),
});
export type CollaboratorTypistFork = typeof CollaboratorTypistFork.Type;

/** `shared`: someone else can see this thread, so its composer heartbeats. */
export const CollaboratorTypingStateFork = Schema.Struct({
  shared: Schema.Boolean,
  typists: Schema.Array(CollaboratorTypistFork),
  /** A collaborator's own name, so their client knows which sent messages are theirs. */
  you: Schema.optional(Schema.String),
  /** Everyone the thread is shared with, in the order they joined, so every client colours them alike. */
  people: Schema.optional(Schema.Array(Schema.String)),
});
export type CollaboratorTypingStateFork = typeof CollaboratorTypingStateFork.Type;

/** A heartbeat while a draft is open; the server forgets a typist it stops hearing from. */
export const CollaboratorSetTypingInputFork = Schema.Struct({
  threadId: ThreadId,
  typing: Schema.Boolean,
  draft: Schema.optional(CollaboratorDraftFork),
  /** One per open composer, so a person's devices never replace or stop each other's draft. */
  device: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type CollaboratorSetTypingInputFork = typeof CollaboratorSetTypingInputFork.Type;

/** Who wrote a user message the host's agent got in a shared thread. Only the server sets it. */
export const CollaboratorAttributionFork = Schema.Struct({
  name: Schema.String,
  /** The collaborator's own words; the message text carries the attributed form the agent reads. */
  text: Schema.String,
  /** Set when the message waited for approval and the host sent it. */
  sentByHost: Schema.optional(Schema.Literal(true)),
  /** The host's own message in a shared thread: named for the agent, shown as the host's. */
  host: Schema.optional(Schema.Literal(true)),
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

/**
 * A saved colleague: their server and this one each hold a collaborator grant for the other, so
 * either side shares a thread with no link. Access stays per thread, as for any collaborator.
 */
export const ColleagueFork = Schema.Struct({
  /** Their collaborator subject here: what shares, sessions, and removal key on. */
  subject: Schema.String,
  name: Schema.String,
  /** Their environment; a client attaches it and reads its shared threads as theirs. */
  environmentId: EnvironmentId,
  /** Where their server answered when they were saved. */
  url: Schema.String,
  savedAt: IsoDateTime,
  /** The threads shared live with them from here. */
  threadIds: Schema.Array(ThreadId),
});
export type ColleagueFork = typeof ColleagueFork.Type;

/** One server's collaborator grant for the other's, carried once by the accepting client. */
export const ColleagueGrantFork = Schema.Struct({
  environmentId: EnvironmentId,
  /** The issuing server's http(s) origin, as public as it knows. */
  url: Schema.String,
  /** The subject the token carries on the issuing server. */
  subject: Schema.String,
  token: Schema.RedactedFromValue(TrimmedNonEmptyString),
});
export type ColleagueGrantFork = typeof ColleagueGrantFork.Type;

/** Accept step 1, on the accepting client's own server: a grant for the sharer. */
export const ColleagueInviteInputFork = Schema.Struct({
  /** The sharer's environment, from the descriptor of the host the client just paired with. */
  environmentId: EnvironmentId,
  /** What this side calls the sharer. */
  name: CollaboratorNameFork,
  linkBaseUrl: Schema.optional(Schema.String),
});
export type ColleagueInviteInputFork = typeof ColleagueInviteInputFork.Type;

/** Accept step 2, on the sharer's server over the collaborator session: answers with its grant. */
export const ColleagueSaveInputFork = Schema.Struct({
  grant: ColleagueGrantFork,
  linkBaseUrl: Schema.optional(Schema.String),
});
export type ColleagueSaveInputFork = typeof ColleagueSaveInputFork.Type;

/** Accept step 3, on the accepting client's own server: keeps the sharer's grant. */
export const ColleagueConnectInputFork = Schema.Struct({
  /** The `subject` of step 1's grant. */
  subject: Schema.String,
  name: CollaboratorNameFork,
  grant: ColleagueGrantFork,
});
export type ColleagueConnectInputFork = typeof ColleagueConnectInputFork.Type;

export const ColleagueSubjectInputFork = Schema.Struct({ subject: Schema.String });
export type ColleagueSubjectInputFork = typeof ColleagueSubjectInputFork.Type;

export const ColleagueRemoveResultFork = Schema.Struct({
  /** Their server dropped this side too; false when it could not be reached. */
  endedThere: Schema.Boolean,
});
export type ColleagueRemoveResultFork = typeof ColleagueRemoveResultFork.Type;

/** A one-time code for this client to pair with a colleague's server as the saved colleague. */
export const ColleagueClientPairingFork = Schema.Struct({
  environmentId: EnvironmentId,
  url: Schema.String,
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ColleagueClientPairingFork = typeof ColleagueClientPairingFork.Type;

export const ColleagueShareThreadInputFork = Schema.Struct({
  threadId: ThreadId,
  subject: Schema.String,
  access: Schema.optional(CollaboratorAccessFork),
});
export type ColleagueShareThreadInputFork = typeof ColleagueShareThreadInputFork.Type;

/** A message for a colleague's thread, kept on this server until their machine is back. */
export const ColleagueQueuedMessageFork = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The colleague's environment, which hosts the thread. */
  environmentId: EnvironmentId,
  threadId: ThreadId,
  text: Schema.String,
  queuedAt: IsoDateTime,
});
export type ColleagueQueuedMessageFork = typeof ColleagueQueuedMessageFork.Type;

export const ColleagueQueueMessageInputFork = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  text: CollaboratorMessageText,
});
export type ColleagueQueueMessageInputFork = typeof ColleagueQueueMessageInputFork.Type;

export const ColleagueUnqueueMessageInputFork = Schema.Struct({ id: TrimmedNonEmptyString });

/** One id for a collaborator message on either path, so the thread's receipt sees it once. */
export const collaboratorMessageCommandId = (id: string) => `collaborator-message:${id}`;

export class ColleagueMissingErrorFork extends Schema.TaggedError<ColleagueMissingErrorFork>()(
  "ColleagueMissingErrorFork",
  { subject: Schema.String },
) {
  override get message(): string {
    return "That colleague is not saved here.";
  }
}

export class ColleagueStorageErrorFork extends Schema.TaggedError<ColleagueStorageErrorFork>()(
  "ColleagueStorageErrorFork",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read or save colleagues.";
  }
}

export class ColleagueSelfErrorFork extends Schema.TaggedError<ColleagueSelfErrorFork>()(
  "ColleagueSelfErrorFork",
  {},
) {
  override get message(): string {
    return "That is this environment.";
  }
}

export class ColleagueOwnGrantErrorFork extends Schema.TaggedError<ColleagueOwnGrantErrorFork>()(
  "ColleagueOwnGrantErrorFork",
  {},
) {
  override get message(): string {
    return "That grant is from this environment.";
  }
}

export class ColleagueNotCollaboratorErrorFork extends Schema.TaggedError<ColleagueNotCollaboratorErrorFork>()(
  "ColleagueNotCollaboratorErrorFork",
  {},
) {
  override get message(): string {
    return "That subject is not a collaborator's.";
  }
}

export class ColleagueNoLiveShareErrorFork extends Schema.TaggedError<ColleagueNoLiveShareErrorFork>()(
  "ColleagueNoLiveShareErrorFork",
  {},
) {
  override get message(): string {
    return "Only a collaborator with a shared thread saves its sharer.";
  }
}

/** The calling grant holds none of the collaborator scopes. */
export class ColleagueNoScopeErrorFork extends Schema.TaggedError<ColleagueNoScopeErrorFork>()(
  "ColleagueNoScopeErrorFork",
  {},
) {
  override get message(): string {
    return "That grant cannot attach a client.";
  }
}

export class ColleagueSavedAsAnotherErrorFork extends Schema.TaggedError<ColleagueSavedAsAnotherErrorFork>()(
  "ColleagueSavedAsAnotherErrorFork",
  {},
) {
  override get message(): string {
    return "That environment is saved here as another colleague.";
  }
}

export class ColleagueNotHttpErrorFork extends Schema.TaggedError<ColleagueNotHttpErrorFork>()(
  "ColleagueNotHttpErrorFork",
  {},
) {
  override get message(): string {
    return "Their address is not an http or https address.";
  }
}

/** `origin` is the address's scheme and host only. */
export class ColleaguePublicHttpErrorFork extends Schema.TaggedError<ColleaguePublicHttpErrorFork>()(
  "ColleaguePublicHttpErrorFork",
  { origin: Schema.String },
) {
  override get message(): string {
    return `${this.origin} is public plain http.`;
  }
}

export class ColleagueSilentErrorFork extends Schema.TaggedError<ColleagueSilentErrorFork>()(
  "ColleagueSilentErrorFork",
  { colleague: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.colleague}'s server did not answer.`;
  }
}

/** Their server answered 401 or 403 to this side's grant. */
export class ColleagueRevokedErrorFork extends Schema.TaggedError<ColleagueRevokedErrorFork>()(
  "ColleagueRevokedErrorFork",
  { colleague: Schema.String },
) {
  override get message(): string {
    return `${this.colleague}'s server no longer accepts this one.`;
  }
}

export class ColleagueRemoteErrorFork extends Schema.TaggedError<ColleagueRemoteErrorFork>()(
  "ColleagueRemoteErrorFork",
  { colleague: Schema.String, status: Schema.Number },
) {
  override get message(): string {
    return `${this.colleague}'s server answered ${this.status}.`;
  }
}

export class ColleagueUnknownShapeErrorFork extends Schema.TaggedError<ColleagueUnknownShapeErrorFork>()(
  "ColleagueUnknownShapeErrorFork",
  { colleague: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.colleague}'s server answered in an unknown shape.`;
  }
}

export const ColleagueErrorFork = Schema.Union([
  ColleagueMissingErrorFork,
  ColleagueStorageErrorFork,
  ColleagueSelfErrorFork,
  ColleagueOwnGrantErrorFork,
  ColleagueNotCollaboratorErrorFork,
  ColleagueNoLiveShareErrorFork,
  ColleagueNoScopeErrorFork,
  ColleagueSavedAsAnotherErrorFork,
  ColleagueNotHttpErrorFork,
  ColleaguePublicHttpErrorFork,
  ColleagueSilentErrorFork,
  ColleagueRevokedErrorFork,
  ColleagueRemoteErrorFork,
  ColleagueUnknownShapeErrorFork,
]);
export type ColleagueErrorFork = typeof ColleagueErrorFork.Type;

/** Server-to-server routes a colleague's server calls with its grant here. */
export const COLLEAGUE_PAIR_CLIENT_ROUTE_FORK = "/api/fork/colleague/pair-client";
export const COLLEAGUE_FORGET_ROUTE_FORK = "/api/fork/colleague/forget";

/** Query param on a `t3code://pair` link naming the thread to open after pairing. */
export const COLLABORATOR_THREAD_LINK_PARAM = "thread";
