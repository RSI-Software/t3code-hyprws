import { assert, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { resolveShortcutCommand } from "./keybindings";

it("hops between the composer and terminal with Ctrl+`", () => {
  const event = { key: "`", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  for (const [terminalFocus, expected] of [
    [false, "terminal.focus"],
    [true, "chat.focusComposer"],
  ] as const) {
    assert.strictEqual(
      resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus },
      }),
      expected,
    );
  }
});
