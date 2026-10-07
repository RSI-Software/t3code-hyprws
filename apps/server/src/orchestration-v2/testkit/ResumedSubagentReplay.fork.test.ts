import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  assertSemanticProjectionIntegrity,
  projectionFor,
  SUBAGENT_CONTINUE_CHILD_PROMPT,
} from "./fixtures/shared.ts";
import {
  runClaudeResumeReplayFork,
  runCodexContinueReplayFork,
} from "./ResumedSubagentReplay.fork.ts";

describe("resumed child replay persistence", () => {
  it.effect.each(["failed", "completed"] as const)(
    "persists the Claude child prompt and items once after a %s child resumes across restart",
    (status) =>
      Effect.gen(function* () {
        const { result, transcript } = yield* runClaudeResumeReplayFork(status);
        const parent = projectionFor(result, transcript.scenario);
        assert.equal(parent.runs[0]?.providerThreadId, parent.runs[1]?.providerThreadId);
        const task = parent.subagents[0]!;
        assert.equal(task.runId, parent.runs[1]?.id);
        assert.equal(task.status, "completed");
        const child = result.projections.get(task.childThreadId!);
        assert.isDefined(child);
        assertSemanticProjectionIntegrity(parent);
        const conversation = child.turnItems.filter(
          (item) => item.type === "user_message" || item.type === "assistant_message",
        );
        assert.lengthOf(conversation, status === "failed" ? 5 : 4);
        const resumedConversation = conversation.slice(-2);
        assert.deepEqual(
          resumedConversation.map((item) => item.type),
          ["user_message", "assistant_message"],
        );
        assert.include(resumedConversation[0]?.text, "Look again at");
        assert.include(resumedConversation[1]?.text, "Bug/edge case found and fixed");
        assert.lengthOf(
          child.messages.filter((message) => message.text === resumedConversation[0]?.text),
          1,
        );
        assert.lengthOf(
          child.messages.filter((message) => message.text === resumedConversation[1]?.text),
          1,
        );
        assert.lengthOf(
          child.turnItems.filter((item) => item.type === "command_execution"),
          3,
        );
        assert.lengthOf(
          child.nodes.filter((node) => node.kind === "root_turn"),
          1,
        );
        assert.equal(child.nodes.find((node) => node.kind === "root_turn")?.status, "completed");
        const persistedPrompts = result.domainEvents.filter(
          (event) =>
            event.type === "message.updated" &&
            event.threadId === child.thread.id &&
            event.payload.text === resumedConversation[0]?.text,
        );
        assert.lengthOf(persistedPrompts, 1);
        assert.equal(persistedPrompts[0]?.runId, parent.runs[1]?.id);
        assert.isFalse(
          parent.messages.some((message) => message.text.includes("Bug/edge case found and fixed")),
        );
      }),
  );

  it.effect("persists Codex subagent_continue child events exactly once", () =>
    Effect.gen(function* () {
      const { result, transcript } = yield* runCodexContinueReplayFork;
      const parent = projectionFor(result, transcript.scenario);
      assert.equal(parent.runs[0]?.providerThreadId, parent.runs[1]?.providerThreadId);
      const child = result.projections.get(parent.subagents[0]!.childThreadId!);
      assert.isDefined(child);
      for (const text of [SUBAGENT_CONTINUE_CHILD_PROMPT, "continued subagent response"]) {
        assert.lengthOf(
          child.messages.filter((message) => message.text === text),
          1,
        );
        assert.lengthOf(
          child.turnItems.filter(
            (item) =>
              (item.type === "user_message" || item.type === "assistant_message") &&
              item.text === text,
          ),
          1,
        );
        const events = result.domainEvents.filter(
          (event) =>
            event.type === "message.updated" &&
            event.threadId === child.thread.id &&
            event.payload.text === text,
        );
        // Codex may repeat a final snapshot for the same message. There
        // must still be one artifact, and only the resuming run may ingest it.
        assert.isNotEmpty(events);
        assert.equal(
          new Set(
            events.flatMap((event) => (event.type === "message.updated" ? [event.payload.id] : [])),
          ).size,
          1,
        );
        for (const event of events) assert.equal(event.runId, parent.runs[1]?.id);
      }
    }),
  );
});
