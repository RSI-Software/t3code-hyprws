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

describe("rich Markdown editor raw HTML", () => {
  it("renders a styled HTML block as a scoped, sanitized island", async () => {
    const onChange = vi.fn();
    const html = [
      "<style>",
      "#poster .chip{color:rgb(1, 2, 3)}",
      "} body{color:rgb(4, 5, 6)} @scope{",
      "</style>",
      '<div id="poster"><span class="chip" onclick="alert(1)">Chip</span><script>alert(1)</script></div>',
    ].join("\n");
    await using screen = await render(
      editor(`# Doc\n\n${html}\n\nPress <kbd>K</kbd>\n`, onChange),
      {
        router: false,
      },
    );
    const { container } = screen;
    const chip = await vi.waitFor(() => {
      const element = container.querySelector<HTMLElement>("#poster .chip");
      expect(element).not.toBeNull();
      return element!;
    });

    expect(getComputedStyle(chip).color).toBe("rgb(1, 2, 3)");
    expect(getComputedStyle(document.body).color).not.toBe("rgb(4, 5, 6)");
    expect(chip.hasAttribute("onclick")).toBe(false);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<kbd>");
    expect(onChange).not.toHaveBeenCalled();
  });
});
