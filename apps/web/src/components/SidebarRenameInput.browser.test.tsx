import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SidebarRenameInput } from "./SidebarRenameInput";

describe("SidebarRenameInput", () => {
  it("selects its title on focus and commits once on Enter", async () => {
    const onCommit = vi.fn();
    await using screen = await render(
      <SidebarRenameInput
        value="Group title"
        ariaLabel="Group title"
        onValueChange={vi.fn()}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
      { router: false },
    );

    const input = screen.container.querySelector("input")!;
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
    await using screen = await render(
      <SidebarRenameInput
        value="Group title"
        ariaLabel="Group title"
        onValueChange={vi.fn()}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
      { router: false },
    );

    const input = screen.container.querySelector("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
