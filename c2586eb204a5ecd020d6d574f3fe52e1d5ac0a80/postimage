import { describe, expect, it } from "vite-plus/test";

import {
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { type ShortcutEventLike } from "../keybindings";
import {
  shouldClearTerminalSelectionAction,
  shouldForwardThreadTerminalShortcut,
  shouldHandleTerminalExit,
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

describe("terminal selection actions", () => {
  it("clears a pending or currently owned menu when the selection disappears", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: true,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(true);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 4,
        currentRequestId: 4,
      }),
    ).toBe(true);
  });

  it("does not let an old selection popup cancel its replacement right-click menu", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(false);
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
