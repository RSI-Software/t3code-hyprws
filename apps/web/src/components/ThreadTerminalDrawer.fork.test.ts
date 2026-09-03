import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";
import {
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { type ShortcutEventLike } from "../keybindings";
import {
  isTerminalAttachmentDemanded,
  resolveTerminalWindowDemand,
  shouldClearTerminalSelectionAction,
  shouldForwardThreadTerminalShortcut,
  shouldHandleTerminalExit,
  shouldHandleTerminalFocusRequest,
  shouldRestoreTerminalFocusAfterResume,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";
function shortcutEvent(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "x",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}
function binding(command: KeybindingCommand): ResolvedKeybindingsConfig {
  return [
    {
      command,
      shortcut: {
        key: "x",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
    },
  ];
}
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
describe("shouldForwardThreadTerminalShortcut", () => {
  it("forwards every resolved thread navigation command to the window", () => {
    for (const command of [
      "thread.previous",
      "thread.next",
      ...THREAD_JUMP_KEYBINDING_COMMANDS,
    ] satisfies KeybindingCommand[]) {
      expect(
        shouldForwardThreadTerminalShortcut(
          shortcutEvent({ ctrlKey: true }),
          binding(command),
          "Linux",
        ),
      ).toBe(true);
    }
  });
  it("passes the composer focus hop through the terminal", () => {
    expect(
      shouldForwardThreadTerminalShortcut(
        shortcutEvent({ key: "`", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        "Linux",
      ),
    ).toBe(true);
  });
  it("keeps plain input and unrelated shortcuts in the terminal", () => {
    expect(
      shouldForwardThreadTerminalShortcut(shortcutEvent({ key: "a" }), binding("thread.jump.1")),
    ).toBe(false);
    expect(
      shouldForwardThreadTerminalShortcut(
        shortcutEvent({ ctrlKey: true }),
        binding("sidebar.toggle"),
        "Linux",
      ),
    ).toBe(false);
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
  it("handles a non-zero request once when a fresh viewport becomes ready", () => {
    expect(
      shouldHandleTerminalFocusRequest({
        focusOnRequest: true,
        focusRequestId: 4,
        handledFocusRequestId: 0,
      }),
    ).toBe(true);
    expect(
      shouldHandleTerminalFocusRequest({
        focusOnRequest: true,
        focusRequestId: 4,
        handledFocusRequestId: 4,
      }),
    ).toBe(false);
  });
  it("never focuses for the zero no-request sentinel", () => {
    expect(
      shouldHandleTerminalFocusRequest({
        focusOnRequest: true,
        focusRequestId: 0,
        handledFocusRequestId: 0,
      }),
    ).toBe(false);
    expect(
      shouldHandleTerminalFocusRequest({
        focusOnRequest: true,
        focusRequestId: 0,
        handledFocusRequestId: 4,
      }),
    ).toBe(false);
  });
});
