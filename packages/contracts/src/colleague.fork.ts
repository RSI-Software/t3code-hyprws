import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ColleagueShareThreadInputFork = Schema.Struct({
  threadId: ThreadId,
  colleagueName: TrimmedNonEmptyString,
});
export type ColleagueShareThreadInputFork = typeof ColleagueShareThreadInputFork.Type;

export const ColleagueShareThreadResultFork = Schema.Struct({
  pairingUrl: Schema.String,
  appLink: Schema.String,
  /** The colleague already had a share, so their paired app shows this thread without the link. */
  knownColleague: Schema.Boolean,
});
export type ColleagueShareThreadResultFork = typeof ColleagueShareThreadResultFork.Type;

export const ColleagueFork = Schema.Struct({ subject: Schema.String, name: Schema.String });
export type ColleagueFork = typeof ColleagueFork.Type;

export const ColleagueThreadSharesInputFork = Schema.Struct({ threadId: ThreadId });

export const ColleagueThreadSharesResultFork = Schema.Struct({
  sharedWith: Schema.Array(ColleagueFork),
  colleagues: Schema.Array(ColleagueFork),
});
export type ColleagueThreadSharesResultFork = typeof ColleagueThreadSharesResultFork.Type;

export const ColleagueUnshareThreadInputFork = Schema.Struct({
  threadId: ThreadId,
  subject: Schema.String,
});
export type ColleagueUnshareThreadInputFork = typeof ColleagueUnshareThreadInputFork.Type;

const ColleagueShareOperationFork = Schema.Literals([
  "read-thread",
  "thread-missing",
  "read-shares",
  "pair",
  "record-share",
  "unshare",
]);

const COLLEAGUE_SHARE_FAILURE_MESSAGES: Record<typeof ColleagueShareOperationFork.Type, string> = {
  "read-thread": "Could not read the thread.",
  "thread-missing": "This thread no longer exists.",
  "read-shares": "Could not read the shares.",
  pair: "Could not create a pairing link.",
  "record-share": "Could not record the share.",
  unshare: "Could not stop sharing.",
};

export class ColleagueShareErrorFork extends Schema.TaggedError<ColleagueShareErrorFork>()(
  "ColleagueShareErrorFork",
  {
    operation: ColleagueShareOperationFork,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return COLLEAGUE_SHARE_FAILURE_MESSAGES[this.operation];
  }
}

/** Query param on a `t3code://pair` link naming the thread to open after pairing. */
export const COLLEAGUE_THREAD_LINK_PARAM = "thread";
