// @vitest-environment happy-dom
import { defaultValueCtx, Editor, rootCtx } from "@milkdown/kit/core";
import { getMarkdown } from "@milkdown/kit/utils";
import { describe, expect, it } from "vite-plus/test";

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
});
