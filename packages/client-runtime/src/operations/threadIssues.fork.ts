import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

/**
 * Thread ↔ GitHub issue links are fork-owned end to end (RSI-Software/t3code-hyprws#1432):
 * upstream `operations/commands.ts` keeps its dispatch helpers private, so this module
 * re-derives the small pieces it needs, as `checkoutMove.fork.ts` does.
 */
type ThreadIssueCommandType = "thread.issue.link" | "thread.issue.unlink";
type ThreadIssueCommandInput<T extends ThreadIssueCommandType> = Omit<
  Extract<OrchestrationV2Command, { readonly type: T }>,
  "type" | "commandId"
>;

type LinkThreadIssueInput = ThreadIssueCommandInput<"thread.issue.link">;
type UnlinkThreadIssueInput = ThreadIssueCommandInput<"thread.issue.unlink">;

const newCommandId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
});

export const linkThreadIssue = Effect.fn("EnvironmentCommands.linkThreadIssue")(function* (
  input: LinkThreadIssueInput,
) {
  return yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    ...input,
    type: "thread.issue.link",
    commandId: yield* newCommandId,
  });
});

export const unlinkThreadIssue = Effect.fn("EnvironmentCommands.unlinkThreadIssue")(function* (
  input: UnlinkThreadIssueInput,
) {
  return yield* request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    ...input,
    type: "thread.issue.unlink",
    commandId: yield* newCommandId,
  });
});
