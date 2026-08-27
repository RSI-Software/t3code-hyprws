import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig, isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes";
import { act, fakeTimers, render } from "../../test/render";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS, useThreadJumpHintsVisible } from "./Sidebar.logic";

const ROUTE_THREAD_REF = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
};

function JumpHints(props: { readonly keybindings: ResolvedKeybindingsConfig }) {
  const shown = useThreadJumpHintsVisible(props.keybindings, ROUTE_THREAD_REF);
  return <output>{shown ? "shown" : "hidden"}</output>;
}

describe("useThreadJumpHintsVisible", () => {
  forkSupersedes({
    upstream:
      "apps/web/src/components/Sidebar.logic.browser.test.tsx > follows terminal focus and the route thread's terminal while the modifier is held",
    reason:
      "Fork thread navigation honors the binding's terminalFocus condition instead of unconditionally hiding hints in terminals.",
    commit: "441393984f",
  });
  it.each(["terminalOpen", "terminalOpen && !terminalFocus"])(
    "follows terminal focus and the route thread's terminal while the modifier is held",
    async (when) => {
      using stack = new DisposableStack();
      const terminal = document.createElement("div");
      terminal.dataset.terminalOwner = "drawer";
      const terminalInput = document.createElement("textarea");
      terminal.append(terminalInput);
      document.body.append(terminal);
      stack.defer(() => terminal.remove());
      stack.defer(() =>
        useTerminalUiStateStore.getState().setTerminalOpen(ROUTE_THREAD_REF, false),
      );
      const keybindings = compileResolvedKeybindingsConfig([
        { key: "mod+1", command: "thread.jump.1", when },
      ]);
      const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
      await using screen = await render(<JumpHints keybindings={keybindings} />, {
        // A bare hook host; nothing here links or navigates.
        router: false,
      });
      using _timers = fakeTimers();
      const output = screen.getByRole("status");

      await userEvent.keyboard(`{${modifier}>}`);
      await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
      await expect.element(output).toHaveTextContent("hidden");
      await act(() => useTerminalUiStateStore.getState().setTerminalOpen(ROUTE_THREAD_REF, true));
      await expect.element(output).toHaveTextContent("shown");
      await act(() => terminalInput.focus());
      await expect.element(output).toHaveTextContent(when === "terminalOpen" ? "shown" : "hidden");
      await act(() => terminalInput.blur());
      await expect.element(output).toHaveTextContent("shown");
      await userEvent.keyboard(`{/${modifier}}`);
      await expect.element(output).toHaveTextContent("hidden");
    },
  );
});
