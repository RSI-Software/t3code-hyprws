import { describe, expect, it } from "vite-plus/test";
import {
  nextTerminalFocusRequestId,
  shouldAutoFocusComposerOnThreadChange,
} from "./ChatView.logic";

describe("composer focus on thread change", () => {
  it("depends only on active thread identity, not terminal open state", () => {
    expect(shouldAutoFocusComposerOnThreadChange("thread-1")).toBe(true);
  });

  it("does not request focus without an active thread", () => {
    expect(shouldAutoFocusComposerOnThreadChange(null)).toBe(false);
  });
});

describe("terminal focus requests", () => {
  it("resets the outstanding request when the active thread changes", () => {
    expect(nextTerminalFocusRequestId("thread-1", "thread-2", 4)).toBe(0);
  });

  it("preserves the request while the active thread is unchanged", () => {
    expect(nextTerminalFocusRequestId("thread-1", "thread-1", 4)).toBe(4);
  });
});
