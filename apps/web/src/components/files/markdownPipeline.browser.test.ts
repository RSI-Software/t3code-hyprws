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
      'H<sub>2</sub>O, <abbr title="Markup">HTML</abbr>, <b><i>x</i></b> and <kbd>\n',
      "<details>\n<summary>More</summary>\n\n- Markdown **inside**\n\n</details>\n",
      '<div align="center">\n\n<div>\n\nNested\n\n</div>\n\n</div>\n',
      "==Marked== ==**bold**== and a == b == c\n",
      ":rocket: :+1: and :nope: at 10:30:00\n",
    ].join("\n");
    expect(await roundTrip(markdown)).toBe(markdown);
  });

  it("keeps escaped dollars from becoming math after a save", async () => {
    const markdown = "\\$5 and \\$6\n\n\\$5 then $x$\n\nCosts $5 then *\\$6*\n";
    const saved = await roundTrip(markdown);
    expect(await roundTrip(saved)).toBe(saved);
    expect(saved).toBe("\\$5 and \\$6\n\n\\$5 then $x$\n\nCosts \\$5 then *$6*\n");
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
          imageUrl: { current: async () => null },
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

  it("loads workspace images through minted URLs", async () => {
    const root = document.createElement("div");
    const pixel = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const imageUrl = vi.fn(async (path: string) => (path.endsWith("icon.png") ? pixel : null));
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          '![Icon](icon.png) ![Remote](https://example.com/r.png)\n\n<img src="../logo.png">\n',
        );
      }),
    )
      .use(
        markdownEditorPresentation({
          cwd: { current: "/workspace" },
          sourcePath: { current: "docs/user/showcase.md" },
          onOpenFile: { current: () => undefined },
          theme: { current: "dark" },
          imageUrl: { current: imageUrl },
        }),
      )
      .create();
    try {
      const [icon, remote, logo] = root.querySelectorAll("img");
      expect(imageUrl.mock.calls).toEqual([
        ["/workspace/docs/user/icon.png"],
        ["/workspace/docs/user/../logo.png"],
      ]);
      expect(remote?.getAttribute("src")).toBe("https://example.com/r.png");
      expect(logo?.hasAttribute("src")).toBe(false);
      await vi.waitFor(() => expect(icon?.getAttribute("src")).toBe(pixel));
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

  it("turns typed shortcodes into emoji", async () => {
    await using root = Object.assign(document.body.appendChild(document.createElement("div")), {
      [Symbol.asyncDispose]: async () => root.remove(),
    });
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, "Hi `x`\n");
      }),
    ).create();
    // Without it, typed spaces arrive as non-breaking spaces.
    root.style.whiteSpace = "pre-wrap";
    try {
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
      view.focus();
      await userEvent.keyboard(":tada:");
      expect(editor.action(getMarkdown())).toBe("Hi `x:tada:`\n");
      view.dispatch(view.state.tr.removeStoredMark(view.state.schema.marks["inlineCode"]!));
      await userEvent.keyboard(" :tada: :nope:");
      expect(root.querySelector('[data-emoji="tada"]')?.textContent).toBe("🎉");
      expect(editor.action(getMarkdown())).toBe("Hi `x:tada:` :tada: :nope:\n");
    } finally {
      await editor.destroy();
    }
  });

  it("keeps split HTML links and forms from navigating the app", async () => {
    const root = document.createElement("div");
    const editor = await markdownPipeline(
      Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(
          defaultValueCtx,
          '<form action="/away">\n<a href="/away">Away</a>\n\nInside\n\n</form>\n',
        );
      }),
    )
      .use(
        markdownEditorPresentation({
          cwd: { current: "/workspace" },
          sourcePath: { current: "README.md" },
          onOpenFile: { current: () => undefined },
          theme: { current: "dark" },
          imageUrl: { current: async () => null },
        }),
      )
      .create();
    try {
      const form = root.querySelector(".t3-markdown-editor__html form");
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
      form?.querySelector("a")?.dispatchEvent(click);
      form?.dispatchEvent(submit);
      expect([click.defaultPrevented, submit.defaultPrevented]).toEqual([true, true]);
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
          "- [ ] Ship it\n\n[README](../../README.md) $x^2$ <kbd>Ctrl</kbd> <kbd>\n\n<details open>\n<summary>More</summary>\n\n**Inside**\n\n</details>\n\n```ts\nconst ready = true;\nconst done = false;\n```\n",
        );
      }),
    )
      .use(
        markdownEditorPresentation({
          cwd: { current: "/workspace" },
          sourcePath: { current: "docs/user/showcase.md" },
          onOpenFile: { current: openFile },
          theme: { current: "dark" },
          imageUrl: { current: async () => null },
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

    const html = [...root.querySelectorAll('[data-type="html"]')];
    expect(
      html.map((island) => island.querySelector("kbd")?.textContent ?? island.textContent),
    ).toEqual(["Ctrl", "<kbd>"]);
    const details = root.querySelector(".t3-markdown-editor__html details[open]");
    expect(details?.querySelector('summary[contenteditable="false"]')?.textContent).toBe("More");
    expect(details?.querySelector("strong")?.textContent).toBe("Inside");

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
