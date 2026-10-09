import { describe, expect, it, vi } from "vite-plus/test";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  applyTerminalAttachStreamEvent,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";

import { synchronizeTerminalOutput } from "../../components/ThreadTerminalDrawer";
import { GhosttyTerminalCore } from "./core";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

describe("terminal output selection", () => {
  it("preserves selection through tmux redraws and clears it when output is replaced", async () => {
    const core = await GhosttyTerminalCore.create(
      12,
      3,
      8,
      16,
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      () => {},
    );
    try {
      const identity = { threadId: "selection-test", terminalId: "term-1" };
      let state = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
        type: "output",
        ...identity,
        data: "copy this\x1b[?1002h\x1b[?1006h",
      });
      const cursor = synchronizeTerminalOutput(core, state, INITIAL_TERMINAL_OUTPUT_CURSOR);
      core.setSelection({ x: 0, y: 0 }, { x: 8, y: 0 });
      expect(core.selectionText()).toBe("copy this");

      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        ...identity,
        data: "\x1b7\x1b[3;1Hstatus\x1b8",
      });
      const next = synchronizeTerminalOutput(core, state, cursor);
      expect(core.selectionText()).toBe("copy this");

      state = applyTerminalAttachStreamEvent(state, { type: "cleared", ...identity });
      synchronizeTerminalOutput(core, state, next);
      expect(core.selectionText()).toBe("");
    } finally {
      core.dispose();
    }
  });
});
