// Fork-only: the eager Claude fork's cursor mechanics — the source session id
// must be a native UUID, and turn boundaries come from the CLONE's
// human-prompt rows only (native forks rewrite every UUID).
import { describe, expect, it } from "@effect/vitest";

import {
  claudeForkTurnBoundaries,
  decodeClaudeHistoryMessages,
  isClaudeHumanTurnStartFork,
  readClaudeForkSourceSessionId,
} from "./ClaudeThreadFork.fork.ts";

const VALID_UUID = "0f0e0d0c-0b0a-4918-8a2b-3c4d5e6f7a8b";

describe("readClaudeForkSourceSessionId", () => {
  it("accepts a native session uuid", () => {
    expect(readClaudeForkSourceSessionId({ resume: VALID_UUID, turnCount: 3 })).toBe(VALID_UUID);
  });

  it("rejects junk, nulls, and non-objects", () => {
    expect(readClaudeForkSourceSessionId({ resume: "not-a-uuid" })).toBeUndefined();
    expect(readClaudeForkSourceSessionId({ resume: 42 })).toBeUndefined();
    expect(readClaudeForkSourceSessionId({})).toBeUndefined();
    expect(readClaudeForkSourceSessionId(null)).toBeUndefined();
    expect(readClaudeForkSourceSessionId("cursor")).toBeUndefined();
  });
});

describe("claudeForkTurnBoundaries", () => {
  it("keeps human prompts and drops tool results and assistant rows", () => {
    const messages = [
      {
        type: "user",
        uuid: "11111111-1111-4111-8111-111111111111",
        parent_tool_use_id: null,
        message: { content: "first prompt" },
      },
      {
        type: "assistant",
        uuid: "22222222-2222-4222-8222-222222222222",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "answer" }] },
      },
      {
        // A tool result arrives as a user-role message but never starts a turn.
        type: "user",
        uuid: "33333333-3333-4333-8333-333333333333",
        parent_tool_use_id: "toolu_1",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
      },
      {
        type: "user",
        uuid: "44444444-4444-4444-8444-444444444444",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "image", source: {} },
            { type: "text", text: "look at this" },
          ],
        },
      },
    ];
    expect(claudeForkTurnBoundaries(messages)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(isClaudeHumanTurnStartFork(messages[1]!)).toBe(false);
  });

  it("yields no boundaries for a clone without human turns", () => {
    expect(claudeForkTurnBoundaries([])).toEqual([]);
  });

  it("reads a compacted clone whose system rows carry no message", () => {
    // `getSessionMessages` omits `message` on system rows; compaction puts one first.
    const messages = decodeClaudeHistoryMessages(
      JSON.stringify([
        {
          type: "system",
          uuid: "55555555-5555-4555-8555-555555555555",
          parent_tool_use_id: null,
        },
        {
          type: "user",
          uuid: "66666666-6666-4666-8666-666666666666",
          parent_tool_use_id: null,
          message: { content: "after compaction" },
        },
      ]),
    );
    expect(claudeForkTurnBoundaries(messages)).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });
});
