import { describe, expect, it } from "vite-plus/test";
import {
  readTerminalCheckoutMode,
  terminalCheckoutModeKey,
  updateTerminalCheckoutMode,
} from "./terminalCheckoutMode";

describe("mobile terminal checkout mode", () => {
  const key = terminalCheckoutModeKey({
    environmentId: "environment-a",
    threadId: "thread-a",
    terminalId: "term-1",
  });

  it("uses collision-safe device-local keys and follows by default", () => {
    expect(key).toBe('["environment-a","thread-a","term-1"]');
    expect(readTerminalCheckoutMode({}, key)).toBe("follow");
  });

  it("stores only explicit pins and preserves concurrent preference entries", () => {
    const pinned = updateTerminalCheckoutMode(
      { terminalCheckoutModes: { other: "pin" } },
      key,
      "pin",
    );
    expect(pinned).toEqual({ terminalCheckoutModes: { other: "pin", [key]: "pin" } });
    expect(updateTerminalCheckoutMode(pinned, key, "follow")).toEqual({
      terminalCheckoutModes: { other: "pin" },
    });
  });
});
