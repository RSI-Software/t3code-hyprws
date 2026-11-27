import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { QUIET_MARKER, quietTurnPayloadFork } from "./quietTurn.fork.ts";

const now = DateTime.makeUnsafe("2026-11-27T00:00:00Z");
const threadId = ThreadId.make("thread:quiet");
const runId = RunId.make("run:quiet");
const userMessageId = MessageId.make("message:quiet-ask");
const base = {
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
} as const;

const asked = (shared: boolean): OrchestrationV2TurnItem => ({
  ...base,
  id: derive.userTurnItem({ messageId: userMessageId }),
  ordinal: 1,
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  messageId: userMessageId,
  inputIntent: "turn_start",
  text: "Jordan, lunch at noon?",
  attachments: [],
  ...(shared
    ? {
        context: {
          version: 1,
          records: [],
          collaboratorFork: { name: "Alex", text: "Jordan, lunch at noon?" },
        },
      }
    : {}),
});

const reply = (
  text: string,
  streaming = false,
): Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> => ({
  ...base,
  id: TurnItemId.make("turn-item:quiet-reply"),
  ordinal: 2,
  type: "assistant_message",
  messageId: MessageId.make("message:quiet-reply"),
  text,
  streaming,
});

const projections = (shared: boolean) => ({
  getRun: () => Effect.succeed({ userMessageId } as OrchestrationV2Run),
  getTurnItem: () => Effect.succeed(asked(shared)),
});

it.effect.each([
  { name: "the marker in a shared thread", shared: true, item: reply(` ${QUIET_MARKER}\n`) },
  { name: "empty text in a shared thread", shared: true, item: reply("") },
])("marks $name quiet", ({ shared, item }) =>
  Effect.gen(function* () {
    const override = yield* quietTurnPayloadFork(projections(shared), item);
    assert.deepEqual(override, { payload: { ...item, quietFork: true } });
  }),
);

it.effect.each([
  { name: "a real reply in a shared thread", shared: true, item: reply("Noon works.") },
  { name: "the marker while it streams", shared: true, item: reply(QUIET_MARKER, true) },
  { name: "the marker in an unshared thread", shared: false, item: reply(QUIET_MARKER) },
])("leaves $name as it is", ({ shared, item }) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* quietTurnPayloadFork(projections(shared), item), {});
  }),
);
