// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TerminalCheckoutModeButton } from "./ThreadTerminalDrawer";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each(["floating", "sidebar"] as const)("%s terminal controls", (layout) => {
  it("changes the active terminal between Follow and Pin", async () => {
    const onModeChange = vi.fn();
    await act(() =>
      root.render(
        <TerminalCheckoutModeButton
          layout={layout}
          terminalId="terminal-2"
          mode="follow"
          onModeChange={onModeChange}
        />,
      ),
    );

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Pin terminal checkout");
    await act(() => button?.click());
    expect(onModeChange).toHaveBeenCalledWith("terminal-2", "pin");

    await act(() =>
      root.render(
        <TerminalCheckoutModeButton
          layout={layout}
          terminalId="terminal-2"
          mode="pin"
          onModeChange={onModeChange}
        />,
      ),
    );
    const followButton = container.querySelector("button");
    expect(followButton?.getAttribute("aria-label")).toBe("Follow thread checkout");
    await act(() => followButton?.click());
    expect(onModeChange).toHaveBeenLastCalledWith("terminal-2", "follow");
  });

  it("keeps the moving checkout lock visible and inert", async () => {
    const onModeChange = vi.fn();
    await act(() =>
      root.render(
        <TerminalCheckoutModeButton
          layout={layout}
          terminalId="terminal-2"
          mode="follow"
          disabled
          onModeChange={onModeChange}
        />,
      ),
    );

    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe(
      "Checkout mode is locked while the thread is moving",
    );
    await act(() => button?.click());
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
