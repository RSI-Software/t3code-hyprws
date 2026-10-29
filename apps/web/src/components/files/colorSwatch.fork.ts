import type { Nodes, Root } from "mdast";

// GitHub draws a swatch after inline code that is exactly one HEX, RGB, or HSL colour.
const COLOR = /^(?:#(?:[0-9a-f]{3}){1,2}|(?:rgb|hsl)a?\([^()]*\))$/i;

/** The inline style of a swatch for `text`, or null when it is not a single colour. */
export function colorSwatchStyle(text: string): string | null {
  if (!COLOR.test(text) || !CSS.supports("color", text)) return null;
  return `display:inline-block;width:0.75em;height:0.75em;margin-inline-start:0.35em;border-radius:50%;vertical-align:-0.05em;box-shadow:0 0 0 1px rgb(127 127 127 / 0.4);background:${text}`;
}

function addSwatches(node: Nodes) {
  if (node.type === "inlineCode") {
    const style = colorSwatchStyle(node.value);
    if (style) {
      node.data = {
        ...node.data,
        hChildren: [
          { type: "text", value: node.value },
          { type: "element", tagName: "span", properties: { style }, children: [] },
        ],
      };
    }
  } else if ("children" in node) {
    node.children.forEach(addSwatches);
  }
}

export const remarkColorSwatch = () => (tree: Root) => addSwatches(tree);
