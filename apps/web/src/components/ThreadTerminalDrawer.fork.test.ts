import { describe, expect, it } from "vite-plus/test";
import {
  isTerminalAttachmentDemanded,
  resolveTerminalWindowDemand,
  lifecycleCursorFork,
} from "./ThreadTerminalDrawer";
import { shouldRestoreTerminalFocusAfterResume } from "./terminalReattachFocus.fork";
describe("terminal attachment demand", () => {
  it("requires both a visible surface and a foreground project window", () => {
    expect(isTerminalAttachmentDemanded(true, true)).toBe(true);
    expect(isTerminalAttachmentDemanded(false, true)).toBe(false);
    expect(isTerminalAttachmentDemanded(true, false)).toBe(false);
  });
  it("prefers Electron demand and falls back to browser document visibility", () => {
    expect(resolveTerminalWindowDemand(false, "visible")).toBe(false);
    expect(resolveTerminalWindowDemand(true, "hidden")).toBe(true);
    expect(resolveTerminalWindowDemand(undefined, "visible")).toBe(true);
    expect(resolveTerminalWindowDemand(undefined, "hidden")).toBe(false);
  });
});
describe("terminal focus requests", () => {
  it("restores project-window focus only after the resumed attachment is running", () => {
    expect(
      shouldRestoreTerminalFocusAfterResume({
        attached: true,
        status: "running",
        restoreRequested: true,
        focusPending: true,
      }),
    ).toBe(true);
    expect(
      shouldRestoreTerminalFocusAfterResume({
        attached: true,
        status: "suspended",
        restoreRequested: true,
        focusPending: true,
      }),
    ).toBe(false);
    expect(
      shouldRestoreTerminalFocusAfterResume({
        attached: true,
        status: "running",
        restoreRequested: false,
        focusPending: true,
      }),
    ).toBe(false);
  });
});

describe("terminal session generations", () => {
  it("forces a full renderer reset when the attached PTY generation changes", () => {
    const cursor = { generation: 4, resetVersion: 7, offset: 99 };

    expect(lifecycleCursorFork(cursor, { lifecycleVersion: 2 }, { lifecycleVersion: 2 })).toBe(
      cursor,
    );
    expect(lifecycleCursorFork(cursor, { lifecycleVersion: 2 }, { lifecycleVersion: 3 })).toEqual({
      generation: -1,
      resetVersion: -1,
      offset: 0,
    });
  });
});
