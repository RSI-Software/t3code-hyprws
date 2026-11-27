import { describe, expect, it } from "vite-plus/test";

import { sendForcedFork, takeForceReplyFork } from "./sendMenu.fork";

const KEY = "env:thread";

describe("Ask the agent", () => {
  it("forces only the send it wraps", () => {
    let forced: boolean | undefined;
    sendForcedFork(KEY, () => (forced = takeForceReplyFork(KEY)));
    expect(forced).toBe(true);
    expect(takeForceReplyFork(KEY)).toBe(false);
  });

  it("leaves the next send normal when the forced one aborts or fails", () => {
    // Refused before the send started, e.g. a held composer.
    sendForcedFork(KEY, () => false);
    expect(takeForceReplyFork(KEY)).toBe(false);
    expect(() =>
      sendForcedFork(KEY, () => {
        throw new Error("send failed");
      }),
    ).toThrow("send failed");
    expect(takeForceReplyFork(KEY)).toBe(false);
  });

  it("never forces another draft's send", () => {
    let other: boolean | undefined;
    sendForcedFork(KEY, () => (other = takeForceReplyFork("env:other")));
    expect(other).toBe(false);
  });
});
