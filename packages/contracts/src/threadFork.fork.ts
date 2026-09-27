// Fork-only: wire contracts for `thread.fork` (fork a thread from the thread
// menu, same provider — Claude and Codex only). The RPC registration lives in
// `rpc.fork.ts`; this module owns the payload, result, and refusal errors so
// the server handler and the web client share one vocabulary.
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ThreadForkInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  childThreadId: ThreadId,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export class ThreadForkSourceMissingError extends Schema.TaggedError<ThreadForkSourceMissingError>()(
  "ThreadForkSourceMissingError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' does not exist.`;
  }
}

export class ThreadForkUnsupportedProviderError extends Schema.TaggedError<ThreadForkUnsupportedProviderError>()(
  "ThreadForkUnsupportedProviderError",
  { threadId: ThreadId, provider: ProviderDriverKind },
) {
  override get message(): string {
    return `Threads on '${this.provider}' cannot be forked. Forking supports Claude and Codex only.`;
  }
}

export class ThreadForkInstanceMismatchError extends Schema.TaggedError<ThreadForkInstanceMismatchError>()(
  "ThreadForkInstanceMismatchError",
  {
    threadId: ThreadId,
    threadInstanceId: ProviderInstanceId,
    bindingInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' selects provider instance '${this.threadInstanceId}' but its session is bound to '${this.bindingInstanceId}'.`;
  }
}

export class ThreadForkNotQuiescentError extends Schema.TaggedError<ThreadForkNotQuiescentError>()(
  "ThreadForkNotQuiescentError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["turn", "requests"]),
  },
) {
  override get message(): string {
    return this.reason === "turn"
      ? `Thread '${this.threadId}' has a turn running or queued. Wait for it to finish before forking.`
      : `Thread '${this.threadId}' has pending requests. Answer them before forking.`;
  }
}

export class ThreadForkSourceStateError extends Schema.TaggedError<ThreadForkSourceStateError>()(
  "ThreadForkSourceStateError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["deleted", "archived", "no-cursor", "no-fork-point", "no-history"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "deleted":
        return `Thread '${this.threadId}' is deleted and cannot be forked.`;
      case "archived":
        return `Thread '${this.threadId}' is archived and cannot be forked.`;
      case "no-cursor":
        return `Thread '${this.threadId}' has no provider session to fork from.`;
      case "no-fork-point":
        return `Thread '${this.threadId}' has no completed turn to fork at.`;
      case "no-history":
        return `Thread '${this.threadId}' has no conversation history to fork.`;
    }
  }
}

export class ThreadForkNativeForkError extends Schema.TaggedError<ThreadForkNativeForkError>()(
  "ThreadForkNativeForkError",
  {
    threadId: ThreadId,
    provider: ProviderDriverKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Forking thread '${this.threadId}' failed inside the ${this.provider} session.`;
  }
}

export class ThreadForkOrchestrationError extends Schema.TaggedError<ThreadForkOrchestrationError>()(
  "ThreadForkOrchestrationError",
  {
    threadId: ThreadId,
    /** Null while the failure predates the child's creation. */
    childThreadId: Schema.NullOr(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.childThreadId === null
      ? `Forking thread '${this.threadId}' failed while reading the thread.`
      : `Forked thread '${this.childThreadId}' could not inherit the history of '${this.threadId}'.`;
  }
}
