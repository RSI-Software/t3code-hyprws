// @vitest-environment happy-dom
import { defaultValueCtx, Editor, rootCtx } from "@milkdown/kit/core";
import { getMarkdown } from "@milkdown/kit/utils";
import { describe, expect, it, vi } from "vite-plus/test";

import { markdownEditorPresentation } from "./markdownEditorPresentation";
import { markdownPipeline } from "./markdownPipeline";

async function roundTrip(markdown: string): Promise<string> {
  const root = document.createElement("div");
  const editor = await markdownPipeline(
    Editor.make().config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    }),
  ).create();
  const serialized = editor.action(getMarkdown());
  await editor.destroy();
  return serialized;
}

describe("markdown rich editor pipeline", () => {
  it("preserves YAML frontmatter", async () => {
    const markdown = "---\ntitle: Rich editing\ndraft: false\n---\n\n# Document\n";
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  it("keeps tight lists and task lists tight", async () => {
    const markdown = "- first\n- second\n\nParagraph.\n\n- [ ] open\n- [x] done\n";
    expect(await roundTrip(markdown)).toBe(
      "* first\n* second\n\nParagraph.\n\n* [ ] open\n* [x] done\n",
    );
  });

  it("renders interactive tasks, workspace chips, and code chrome", async () => {
    const root = document.createElement("div");
    const openFile = vi.fn();
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          "- [ ] Ship it\n\n[README](../../README.md)\n\n```ts\nconst ready = true;\nconst done = false;\n```\n",
        );
      }),
    )
      .use(
        markdownEditorPresentation({
          cwd: { current: "/workspace" },
          sourcePath: { current: "docs/user/showcase.md" },
          onOpenFile: { current: openFile },
          theme: { current: "dark" },
        }),
      )
      .create();

    const checkbox = root.querySelector<HTMLInputElement>(
      'li[data-item-type="task"] > input[type="checkbox"]',
    );
    expect(checkbox).not.toBeNull();
    if (checkbox) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(editor.action(getMarkdown())).toContain("* [x] Ship it");

    const fileLink = root.querySelector<HTMLAnchorElement>(
      'a.t3-markdown-editor__file-link[data-file-path="README.md"]',
    );
    expect(fileLink?.querySelector("svg")).not.toBeNull();
    fileLink?.click();
    expect(openFile).toHaveBeenCalledWith("README.md");

    const codeBlock = root.querySelector<HTMLElement>(
      '.t3-markdown-editor__codeblock[data-language="ts"]',
    );
    expect(codeBlock?.querySelector(".t3-markdown-editor__codeblock-language")?.textContent).toBe(
      "ts",
    );
    expect(codeBlock?.querySelector("code")?.textContent).toBe(
      "const ready = true;\nconst done = false;",
    );
    await vi.waitFor(() => {
      expect(
        [...(codeBlock?.querySelectorAll('code span[style*="color"]') ?? [])].some(
          (token) => token.textContent === "false",
        ),
      ).toBe(true);
    });

    await editor.destroy();
  });
});
