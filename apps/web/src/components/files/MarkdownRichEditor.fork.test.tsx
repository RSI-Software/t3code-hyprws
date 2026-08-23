// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MarkdownRichEditor } from "./MarkdownRichEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderEditor(value: string, onChange: (markdown: string) => void) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => {
    root?.render(
      <MarkdownRichEditor
        value={value}
        onChange={onChange}
        cwd="/workspace"
        relativePath="README.md"
        onOpenFile={() => undefined}
        theme="dark"
        wordWrap
      />,
    );
  });
  await vi.waitFor(() => expect(container?.querySelector(".ProseMirror")).not.toBeNull());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

// RSI-Software/t3code-hyprws#1361: the rich editor kept its first document.
describe("rich Markdown editor disk changes", () => {
  it("shows new file contents without saving them back", async () => {
    const onChange = vi.fn();
    await renderEditor("# Before\n\n- one\n", onChange);
    await vi.waitFor(() => expect(container?.textContent).toContain("Before"));

    await renderEditor("# After disk edit\n\n- one\n- two\n", onChange);

    await vi.waitFor(() => expect(container?.textContent).toContain("After disk edit"));
    expect(container?.textContent).toContain("two");
    expect(onChange).not.toHaveBeenCalled();
  });
});
