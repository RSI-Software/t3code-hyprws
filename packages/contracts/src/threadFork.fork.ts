// Fork-only: wire contracts for `thread.fork` (fork a thread from the thread
// menu, same provider — Claude and Codex only). The RPC registration lives in
// `rpc.fork.ts`; this module owns the payload, result, and the single
// reason-coded refusal error so the server handler and the web client share
// one vocabulary.
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ThreadForkInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  childThreadId: ThreadId,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

/**
 * Every way a fork can refuse. One class keeps the client surface a single
 * shape; `reason` carries the case, and the message getter renders the
 * readable text the toast shows. Optional fields appear only where the
 * reason needs them.
 */
export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  threadId: ThreadId,
  reason: Schema.Literals([
    "source-missing",
    "unsupported-provider",
    "instance-mismatch",
    "turn-running",
    "pending-requests",
    "source-deleted",
    "source-archived",
    "no-cursor",
    "no-fork-point",
    "no-history",
    "native-fork-failed",
    "source-race",
    "orchestration-failed",
  ]),
  provider: Schema.optional(ProviderDriverKind),
  childThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  detail: Schema.optional(Schema.String),
}) {
  get baseMessage(): string {
    switch (this.reason) {
      case "source-missing":
        return `Thread '${this.threadId}' does not exist.`;
      case "unsupported-provider":
        return `Threads on '${this.provider}' cannot be forked. Forking supports Claude and Codex only.`;
      case "instance-mismatch":
        return `Thread '${this.threadId}' must route through one provider instance to fork. Switch the model selection to the session's instance and retry.`;
      case "turn-running":
        return `Thread '${this.threadId}' has a turn running or queued. Wait for it to finish before forking.`;
      case "pending-requests":
        return `Thread '${this.threadId}' has pending requests. Answer them before forking.`;
      case "source-deleted":
        return `Thread '${this.threadId}' is deleted and cannot be forked.`;
      case "source-archived":
        return `Thread '${this.threadId}' is archived and cannot be forked.`;
      case "no-cursor":
        return `Thread '${this.threadId}' has no provider session to fork from.`;
      case "no-fork-point":
        return `Thread '${this.threadId}' has no completed turn to fork at.`;
      case "no-history":
        return `Thread '${this.threadId}' has no conversation history to fork.`;
      case "native-fork-failed":
        return `Forking thread '${this.threadId}' failed inside the ${this.provider} session.${
          this.detail !== undefined ? ` ${this.detail}` : ""
        }`;
      case "source-race":
        return `Thread '${this.threadId}' changed while the fork was running. Wait for it to settle and retry.`;
      case "orchestration-failed":
        return this.childThreadId == null
          ? `Forking thread '${this.threadId}' failed before the child was created.${
              this.detail !== undefined ? ` ${this.detail}` : ""
            }`
          : `Forked thread '${this.childThreadId}' could not inherit the history of '${this.threadId}'.${
              this.detail !== undefined ? ` ${this.detail}` : ""
            }`;
    }
  }
  // The wire-facing message: the reason's text plus any server detail, so a
  // refusal toast can copy the concrete cause (instance ids, provider errors).
  override get message(): string {
    const base = this.baseMessage;
    return this.detail && this.detail.length > 0 ? `${base} ${this.detail}` : base;
  }
}
