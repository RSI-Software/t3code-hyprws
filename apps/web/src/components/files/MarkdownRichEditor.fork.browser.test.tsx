import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { MarkdownRichEditor } from "./MarkdownRichEditor";

function editor(value: string, onChange: (markdown: string) => void) {
  return (
    <MarkdownRichEditor
      value={value}
      onChange={onChange}
      onSave={() => undefined}
      cwd="/workspace"
      relativePath="README.md"
      onOpenFile={() => undefined}
      theme="dark"
      wordWrap
    />
  );
}

// RSI-Software/t3code-hyprws#1361: the rich editor kept its first document.
describe("rich Markdown editor disk changes", () => {
  it("shows new file contents without saving them back", async () => {
    const onChange = vi.fn();
    await using screen = await render(editor("# Before\n\n- one\n", onChange), {
      router: false,
    });
    const { container } = screen;
    await vi.waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());
    await vi.waitFor(() => expect(container.textContent).toContain("Before"));

    await screen.rerender(editor("# After disk edit\n\n- one\n- two\n", onChange));
    await vi.waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());

    await vi.waitFor(() => expect(container.textContent).toContain("After disk edit"));
    expect(container.textContent).toContain("two");
    expect(onChange).not.toHaveBeenCalled();
  });
});
