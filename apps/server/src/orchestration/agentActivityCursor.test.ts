import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAgentActivityPageCursor,
  encodeAgentActivityPageCursor,
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
  });

  it.each(["not-base64", "e30", Buffer.from('{"t":"thread-1"}').toString("base64url")])(
    "rejects malformed cursor %s",
    (cursor) => {
      expect(decodeAgentActivityPageCursor(cursor)).toBeNull();
    },
  );
});
