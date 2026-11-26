import { describe, expect, it } from "vite-plus/test";

import { deriveThreadQueueWorkflowState } from "./threadWorkflows.ts";

describe("collaborator queue (fork)", () => {
  it("shows a queued collaborator message as their own words, not the agent's attributed text", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread" },
      runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
      messages: [
        {
          id: "message",
          text: "[Alex, a collaborator the owner shared this thread with, wrote the message below.]\n\nShip it?",
          context: {
            version: 1,
            records: [],
            collaboratorFork: { name: "Alex", text: "Ship it?" },
          },
        },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ text }) => text)).toEqual(["Ship it?"]);
  });
});
