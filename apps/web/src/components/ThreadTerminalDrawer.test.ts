import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { type ShortcutEventLike } from "../keybindings";
import {
  resolveTerminalSelectionActionPosition,
  shouldForwardThreadTerminalShortcut,
  shouldHandleTerminalExit,
  shouldHandleTerminalFocusRequest,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
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

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("uses Ghostty's physical screen range for visually wrapped selections", () => {
    expect(
      terminalSelectionLineRange({
        start: { y: 4 },
        end: { y: 6 },
      }),
    ).toEqual({ lineStart: 5, lineEnd: 7 });
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true)).toBe(false);
  });
});
