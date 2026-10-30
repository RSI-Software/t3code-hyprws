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

export class ColleagueThreadMissingErrorFork extends Schema.TaggedError<ColleagueThreadMissingErrorFork>()(
  "ColleagueThreadMissingErrorFork",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This thread no longer exists.";
  }
}

export class ColleagueShareErrorFork extends Schema.TaggedError<ColleagueShareErrorFork>()(
  "ColleagueShareErrorFork",
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

export class ColleagueUnshareErrorFork extends Schema.TaggedError<ColleagueUnshareErrorFork>()(
  "ColleagueUnshareErrorFork",
  {
    operation: Schema.Literals(["delete-share", "read-shares"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not stop sharing.";
  }
}

/** Query param on a `t3code://pair` link naming the thread to open after pairing. */
export const COLLEAGUE_THREAD_LINK_PARAM = "thread";
