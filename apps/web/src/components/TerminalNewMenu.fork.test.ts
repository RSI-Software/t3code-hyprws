import { expect, it } from "vite-plus/test";
import { terminalSessionModeChoiceFork } from "./TerminalNewMenu.fork";

it("opens the default mode when a click event reaches the add-terminal callback", () => {
  // RightPanelTabs passes `onAddTerminal` straight to onClick.
  const clickEvent = { type: "click", target: {}, preventDefault: () => undefined };
  expect(terminalSessionModeChoiceFork(clickEvent)).toBeUndefined();
  expect(terminalSessionModeChoiceFork(undefined)).toBeUndefined();
  expect(terminalSessionModeChoiceFork("shell")).toBe("shell");
  expect(terminalSessionModeChoiceFork("zmux")).toBe("zmux");
});
