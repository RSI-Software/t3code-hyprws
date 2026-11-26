import { describe, expect, it } from "vite-plus/test";

import { deriveThreadQueueWorkflowState } from "./threadWorkflows.ts";

describe("collaborator queue (fork)", () => {
  it.each([
    {
      who: "a collaborator",
      text: "[Alex, a collaborator the owner shared this thread with, wrote the message below.]\n\nShip it?",
      collaboratorFork: { name: "Alex", text: "Ship it?" },
    },
    {
      who: "the host",
      text: "[Jordan, the owner of this thread, wrote the message below.]\n\nShip it?",
      collaboratorFork: { name: "Jordan", text: "Ship it?", host: true },
    },
  ])(
    "shows $who's queued message as their own words, not the agent's attributed text",
    ({ text, collaboratorFork }) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread" },
        runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
        messages: [{ id: "message", text, context: { version: 1, records: [], collaboratorFork } }],
        providerTurns: [],
        providerThreads: [],
        providerSessions: [],
      } as never);

      expect(state.queuedRuns.map(({ text }) => text)).toEqual(["Ship it?"]);
    },
  );
});
