import { assert, describe, it } from "vite-plus/test";
import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  isChatFocusComposerShortcut,
  isTerminalFocusShortcut,
  resolveShortcutCommand,
  shouldShowThreadJumpHintsForModifiers,
  type ShortcutEventLike,
} from "./keybindings";
import { forkSupersedes } from "../../../scripts/lib/fork-supersedes.ts";
function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}
function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}
function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}
function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}
interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}
function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}
const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyReference",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);
describe("thread navigation helpers", () => {
  forkSupersedes({
    upstream:
      "apps/web/src/keybindings.test.ts > never shows jump hints while the terminal is focused, even with an unrestricted binding",
    reason:
      "the terminal drawer forwards resolved thread jumps to the window ahead of Ghostty encoding, so a focused terminal still shows the hint",
    commit: "75c2629308d",
  });
  it("shows jump hints with terminal focus when the binding is active there", () => {
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    const composerOnlyBindings = compile([
      {
        shortcut: modShortcut("1"),
        command: "thread.jump.1",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), composerOnlyBindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});
describe("focus shortcuts", () => {
  it("resolves Ctrl+` to terminal.focus outside the terminal", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "`", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "terminal.focus",
    );
    assert.isTrue(
      isTerminalFocusShortcut(event({ key: "`", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });
  it("resolves Ctrl+` to chat.focusComposer while the terminal is focused", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "`", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.focusComposer",
    );
    assert.isTrue(
      isChatFocusComposerShortcut(
        event({ key: "`", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "Linux",
          context: { terminalFocus: true },
        },
      ),
    );
  });
});
