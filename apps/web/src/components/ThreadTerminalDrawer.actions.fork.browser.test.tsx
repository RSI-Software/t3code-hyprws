import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { TerminalCheckoutModeButton } from "./ThreadTerminalDrawer";

describe.each(["floating", "sidebar"] as const)("%s terminal controls", (layout) => {
  it("changes the active terminal between Follow and Pin", async () => {
    const onModeChange = vi.fn();
    await using screen = await render(
      <TerminalCheckoutModeButton
        layout={layout}
        terminalId="terminal-2"
        mode="follow"
        onModeChange={onModeChange}
      />,
    );
    const { container } = screen;

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Pin terminal checkout");
    await act(() => button?.click());
    expect(onModeChange).toHaveBeenCalledWith("terminal-2", "pin");

    await screen.rerender(
      <TerminalCheckoutModeButton
        layout={layout}
        terminalId="terminal-2"
        mode="pin"
        onModeChange={onModeChange}
      />,
    );
    const followButton = container.querySelector("button");
    expect(followButton?.getAttribute("aria-label")).toBe("Follow thread checkout");
    await act(() => followButton?.click());
    expect(onModeChange).toHaveBeenLastCalledWith("terminal-2", "follow");
  });

  it("keeps the moving checkout lock visible and inert", async () => {
    const onModeChange = vi.fn();
    await using screen = await render(
      <TerminalCheckoutModeButton
        layout={layout}
        terminalId="terminal-2"
        mode="follow"
        disabled
        onModeChange={onModeChange}
      />,
    );
    const { container } = screen;

    const button = container.querySelector("button");
    // Upstream disables terminal actions by `aria-disabled`, so the tooltip still opens on hover.
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe(
      "Checkout mode is locked while the thread is moving",
    );
    await act(() => button?.click());
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
