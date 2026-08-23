import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import remarkFrontmatter from "remark-frontmatter";

// Frontmatter needs both a remark extension and a ProseMirror carrier node. Without
// them, opening and editing a file can reinterpret YAML as ordinary Markdown.
export const frontmatterRemark = $remark(
  "remarkFrontmatter",
  () => remarkFrontmatter,
  "yaml" as const,
);

export const frontmatterSchema = $nodeSchema("frontmatter", () => ({
  content: "text*",
  group: "block",
  marks: "",
  defining: true,
  code: true,
  parseDOM: [
    {
      tag: "pre[data-frontmatter]",
      preserveWhitespace: "full" as const,
    },
  ],
  toDOM: () =>
    [
      "pre",
      { "data-frontmatter": "true", class: "t3-markdown-frontmatter" },
      ["code", {}, 0],
    ] as const,
  parseMarkdown: {
    match: ({ type }) => type === "yaml",
    runner: (state, node, type) => {
      const value = typeof node["value"] === "string" ? node["value"] : "";
      state.openNode(type);
      if (value) state.addText(value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "frontmatter",
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.textContent);
    },
  },
}));
