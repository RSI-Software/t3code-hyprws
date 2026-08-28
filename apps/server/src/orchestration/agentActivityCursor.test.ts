import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAgentActivityPageCursor,
  encodeAgentActivityPageCursor,
  isAgentActivityPageCursorFor,
} from "./agentActivityCursor.ts";

describe("agent activity cursor", () => {
  it("round-trips the stable activity keyset", () => {
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      agentId: "agent-1",
      beforeSequence: 42,
      beforeCreatedAt: "2026-08-28T00:00:00.000Z",
      beforeActivityId: "activity-42",
    };
    expect(decodeAgentActivityPageCursor(encodeAgentActivityPageCursor(cursor))).toEqual(cursor);
    const encoded = encodeAgentActivityPageCursor(cursor);
    expect(isAgentActivityPageCursorFor(encoded, ThreadId.make("thread-1"), "agent-1")).toBe(true);
    expect(isAgentActivityPageCursorFor(encoded, ThreadId.make("thread-2"), "agent-1")).toBe(false);
    expect(isAgentActivityPageCursorFor(encoded, ThreadId.make("thread-1"), "agent-2")).toBe(false);
    expect(decodeAgentActivityPageCursor(`${encoded}=`)).toBeNull();
    expect(decodeAgentActivityPageCursor(`${encoded}!`)).toBeNull();
  });

  it.each(["not-base64", "e30", Buffer.from('{"t":"thread-1"}').toString("base64url")])(
    "rejects malformed cursor %s",
    (cursor) => {
      expect(decodeAgentActivityPageCursor(cursor)).toBeNull();
      expect(isAgentActivityPageCursorFor(cursor, ThreadId.make("thread-1"), "agent-1")).toBe(
        false,
      );
    },
  );
});
