import { INITIAL_TERMINAL_OUTPUT_CURSOR } from "@t3tools/client-runtime/state/terminal";
import { describe, expect, it } from "vite-plus/test";

import { copyOsc52ClipboardFork } from "./osc52Clipboard.fork";

const cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
// tmux leaves the selection field empty.
const osc52 = (text: string, end = "\x07") =>
  `\x1b]52;;${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}${end}`;

function feed(updates: ReadonlyArray<{ type: "append" | "reset"; data: string }>) {
  const terminal = {};
  const copied: string[] = [];
  for (const update of updates) {
    copyOsc52ClipboardFork(terminal, { ...update, cursor }, (text) => copied.push(text));
  }
  return copied;
}

describe("OSC 52 clipboard", () => {
  it("copies live writes, including UTF-8, ST-terminated, and chunk-split sequences", () => {
    const split = osc52("split ✓", "\x1b\\");
    expect(
      feed([
        { type: "append", data: `before${osc52("tmux yank")}after` },
        { type: "append", data: `x${split.slice(0, 3)}` },
        { type: "append", data: `${split.slice(3, 12)}` },
        { type: "append", data: `${split.slice(12)}y` },
      ]),
    ).toEqual(["tmux yank", "split ✓"]);
  });

  it("never copies replayed history or answers read queries", () => {
    expect(
      feed([
        { type: "reset", data: osc52("old copy") },
        { type: "append", data: "\x1b]52;c;?\x07" },
        { type: "append", data: osc52("half").slice(0, 8) },
        { type: "reset", data: "" },
        { type: "append", data: `${osc52("half").slice(8)}` },
      ]),
    ).toEqual([]);
  });
});
