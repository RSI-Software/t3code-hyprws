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
      "@property --t3-probe{syntax:'*';inherits:false;initial-value:7px}",
      "} body{color:rgb(4, 5, 6)} @scope{",
      "</style>",
      '<div id="poster"><span class="chip" onclick="alert(1)">Chip</span><b popover>Pop</b><script>alert(1)</script></div>',
    ].join("\n");
    const bar = '<div id="bar" style="height:6px;background:rgb(7, 8, 9)"></div>';
    const list = '<ul id="list" title="<b>"><li>One<li>Two</ul>';
    const form =
      '<form id="form" action="/elsewhere"><textarea id="note"><div></textarea><button id="go">Go</button></form>';
    const quoted = '<div id="quoted" title="<textarea>"><textarea></textarea></div>';
    await using screen = await render(
      editor(
        `# Doc\n\n${html}\n\n${bar}\n\n${list}\n\n${form}\n\n${quoted}\n\nPress <kbd>K</kbd>\n`,
        onChange,
      ),
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
    expect(container.querySelector("[popover]")).toBeNull();
    expect(getComputedStyle(document.body).getPropertyValue("--t3-probe")).toBe("");
    expect(container.querySelector("#bar")).not.toBeNull();
    expect(container.querySelectorAll("#list li")).toHaveLength(2);
    expect(container.querySelector<HTMLTextAreaElement>("#note")?.value).toBe("<div>");
    expect(container.querySelector("#quoted textarea")).not.toBeNull();
    let submitPrevented = false;
    const onSubmit = (event: Event) => {
      submitPrevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("submit", onSubmit, { once: true });
    container.querySelector<HTMLButtonElement>("#go")!.click();
    expect(submitPrevented).toBe(true);
    expect(container.textContent).toContain("<kbd>");
    expect(onChange).not.toHaveBeenCalled();
  });
});
