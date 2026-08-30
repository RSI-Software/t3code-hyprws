// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SidebarRenameInput } from "./SidebarRenameInput";

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

describe("SidebarRenameInput", () => {
  it("selects its title on focus and commits once on Enter", async () => {
    const onCommit = vi.fn();
    await act(() =>
      root.render(
        <SidebarRenameInput
          value="Group title"
          ariaLabel="Group title"
          onValueChange={vi.fn()}
          onCommit={onCommit}
          onCancel={vi.fn()}
        />,
      ),
    );

    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("cancels once on Escape without committing on blur", async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    await act(() =>
      root.render(
        <SidebarRenameInput
          value="Group title"
          ariaLabel="Group title"
          onValueChange={vi.fn()}
          onCommit={onCommit}
          onCancel={onCancel}
        />,
      ),
    );

    const input = container.querySelector("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
