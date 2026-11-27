import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { askSkippedLineFork, canAskAgentFork } from "./QuietTurnRow.fork";

const now = DateTime.makeUnsafe("2026-11-27T10:00:00.000Z");
const base = {
  threadId: ThreadId.make("thread-1"),
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

const line = (
  ordinal: number,
  run: string,
  name: string,
  own: string,
): OrchestrationV2TurnItem => ({
  ...base,
  id: TurnItemId.make(`user-${ordinal}`),
  runId: RunId.make(run),
  ordinal,
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  messageId: MessageId.make(`user-${ordinal}`),
  inputIntent: "turn_start",
  text: `[${name} wrote the message below. …]\n\n${own}`,
  context: { version: 1, records: [], collaboratorFork: { name, text: own } },
  attachments: [],
});

const quiet: OrchestrationV2TurnItem = {
  ...base,
  id: TurnItemId.make("quiet"),
  runId: RunId.make("run-2"),
  ordinal: 4,
  type: "assistant_message",
  messageId: MessageId.make("quiet"),
  text: "(listening)",
  streaming: false,
  quietFork: true,
};

describe("askSkippedLineFork", () => {
  it("quotes the quiet run's line in its author's own words", () => {
    const items = [
      line(1, "run-1", "Jordan", "hi Alex"),
      line(3, "run-2", "Alex", "can it build?"),
    ];
    expect(
      askSkippedLineFork(
        items.map((item) => ({ item })),
        quiet,
      ),
    ).toBe(`Answer Alex's message: "can it build?"`);
  });

  it("falls back when the line is not loaded", () => {
    expect(askSkippedLineFork([], quiet)).toBe("Answer the message above.");
  });
});

describe("canAskAgentFork", () => {
  const idle = {
    canOperateThread: true,
    isWorking: false,
    isRevertingCheckpoint: false,
    latestRunId: RunId.make("run-2"),
    quiet,
    shell: {},
  };

  it("offers the ask only on the latest idle turn, never during a rewind", () => {
    expect(canAskAgentFork(idle)).toBe(true);
    expect(canAskAgentFork({ ...idle, isRevertingCheckpoint: true })).toBe(false);
    expect(canAskAgentFork({ ...idle, latestRunId: RunId.make("run-3") })).toBe(false);
  });
});
