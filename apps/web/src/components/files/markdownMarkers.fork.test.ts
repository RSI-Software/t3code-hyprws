// @vitest-environment happy-dom
import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { expect, it } from "vite-plus/test";

import { markdownPipeline } from "./markdownPipeline";

it.each([
  ["none", "---", "x  ", "y  ", "z  "],
  ["right", "--:", "  x", "  y", "  z"],
  ["center", ":-:", " x ", " y ", " z "],
])("formats edited short columns (%s)", async (_alignment, delimiter, header, before, after) => {
  const table = (cell: string) =>
    `| ${header} | a\\|b |\n| ${delimiter} | ---- |\n| ${cell} | c\\|d |\n`;
  const editor = await markdownPipeline(
    Editor.make().config((ctx) => {
      ctx.set(rootCtx, document.createElement("div"));
      ctx.set(defaultValueCtx, table(before!));
    }),
  ).create();
  try {
    expect(editor.action(getMarkdown())).toBe(table(before!));
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.state.doc.descendants((node, position) => {
        if (node.isText && node.text === "y") {
          view.dispatch(view.state.tr.insertText("z", position, position + 1));
        }
      });
    });
    expect(editor.action(getMarkdown())).toBe(table(after!));
  } finally {
    await editor.destroy();
  }
});

it.each([false, true])("round-trips formatter-clean markers (quoted: %s)", async (quoted) => {
  const source =
    "- item\n\n---\n\n| Name | Value | x   |\n| ---- | ----- | --- |\n| one  | two   | y   |\n";
  const markdown = quoted
    ? source
        .trimEnd()
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n") + "\n"
    : source;
  const editor = await markdownPipeline(
    Editor.make().config((ctx) => {
      ctx.set(rootCtx, document.createElement("div"));
      ctx.set(defaultValueCtx, markdown);
    }),
  ).create();
  try {
    expect(editor.action(getMarkdown())).toBe(markdown);
  } finally {
    await editor.destroy();
  }
});
