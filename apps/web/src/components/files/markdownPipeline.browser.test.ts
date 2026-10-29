import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from "@milkdown/core";
import { TextSelection } from "@milkdown/prose/state";
import { getMarkdown } from "@milkdown/utils";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
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

  it("preserves GitHub syntax the editor renders", async () => {
    const markdown = [
      '```ts title="app.ts"\nconst ready = true;\n```\n',
      "Inline $e^{i\\pi} + 1 = 0$ costs $5.\n",
      "$$\n\\int_0^1 x\\,dx = \\tfrac{1}{2}\n$$\n",
      "> [!NOTE]\n> Read **this** first.\n",
      "> [!TIP]\n>\n> Spaced.\n",
      "> [!WARNING]\n>\n> ### Heading\n",
    ].join("\n");
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  it("keeps tight lists and task lists tight", async () => {
    const markdown = "- first\n- second\n\nParagraph.\n\n- [ ] open\n- [x] done\n";
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  it("draws Mermaid and math, and reports invalid source", async () => {
    const root = document.createElement("div");
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          "```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart LR\n  A --> -->\n```\n\n$$\n\\frac{\n$$\n",
        );
      }),
    )
      .use(
        markdownEditorPresentation({
          cwd: { current: "/workspace" },
          sourcePath: { current: "README.md" },
          onOpenFile: { current: () => undefined },
          theme: { current: "dark" },
        }),
      )
      .create();
    try {
      const [valid, invalid] = root.querySelectorAll(".t3-markdown-editor__codeblock--diagram");
      await vi.waitFor(() => {
        expect(valid?.querySelector(".t3-markdown-editor__codeblock-diagram svg")).not.toBeNull();
        expect(invalid?.querySelector(".is-invalid")?.textContent).toContain("Parse error");
        expect(root.querySelector(".t3-markdown-editor__math .is-invalid")).not.toBeNull();
      });
      expect(root.querySelectorAll(".t3-markdown-editor__codeblock--diagram")[1]).toBe(invalid);
    } finally {
      await editor.destroy();
    }
  });

  it("turns quotes into GitHub alerts and back", async () => {
    await using root = Object.assign(document.body.appendChild(document.createElement("div")), {
      [Symbol.asyncDispose]: async () => root.remove(),
    });
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, "> [!NOTE]\n> Read this.\n\n> Plain\n");
      }),
    ).create();
    try {
      const title = root.querySelector('blockquote[data-alert="note"] > [contenteditable="false"]');
      expect(title?.textContent).toBe("Note");
      expect(title?.querySelector("svg")).not.toBeNull();

      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      const caretAt = (text: string) => {
        view.state.doc.descendants((node, position) => {
          if (node.isText && node.text === text) {
            view.dispatch(
              view.state.tr.setSelection(TextSelection.create(view.state.doc, position)),
            );
          }
        });
        view.focus();
      };
      caretAt("Read this.");
      await userEvent.keyboard("{Backspace}");
      caretAt("Plain");
      await userEvent.keyboard("[[!TIP] ");
      expect(editor.action(getMarkdown())).toBe("> Read this.\n\n> [!TIP]\n> Plain\n");
    } finally {
      await editor.destroy();
    }
  });

  it("renders interactive tasks, workspace chips, math, and code chrome", async () => {
    await getSyntaxHighlighterPromise("ts");
    const root = document.createElement("div");
    const openFile = vi.fn();
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          "- [ ] Ship it\n\n[README](../../README.md) $x^2$\n\n```ts\nconst ready = true;\nconst done = false;\n```\n",
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
    expect(editor.action(getMarkdown())).toContain("- [x] Ship it");

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
      expect(root.querySelector(".t3-markdown-editor__math-rendered .katex")).not.toBeNull();
      expect(
        [...(codeBlock?.querySelectorAll('code span[style*="color"]') ?? [])].some(
          (token) => token.textContent === "false",
        ),
      ).toBe(true);
    });

    await editor.destroy();
  });
});
