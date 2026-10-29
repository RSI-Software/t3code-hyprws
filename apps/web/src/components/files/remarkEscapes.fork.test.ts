import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkEmoji } from "./remarkEmoji.fork";
import { remarkHighlight } from "./remarkHighlight.fork";

function markers(markdown: string): string[] {
  const processor = unified().use(remarkParse).use(remarkHighlight).use(remarkEmoji);
  const found: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "emoji") found.push(`:${node.name}:`);
    if (node.type === "highlight")
      found.push(
        `==${node.children.map((child) => ("value" in child ? child.value : "")).join("")}==`,
      );
    if ("children" in node) node.children.forEach(walk);
  };
  walk(processor.runSync(processor.parse(markdown), markdown) as Root);
  return found;
}

describe("file preview Markdown escapes", () => {
  it("leaves escaped highlight and emoji markers as text", () => {
    expect(markers("==a== \\:rocket: :fire:\n\n> x\n> \\==b== and &#58;rocket: c\\==\n")).toEqual([
      "==a==",
      ":fire:",
    ]);
  });
});
