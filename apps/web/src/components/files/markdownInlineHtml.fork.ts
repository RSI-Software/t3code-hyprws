import { $remark } from "@milkdown/utils";
import type { Nodes, Root } from "mdast";

const OPEN_TAG = /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?(?<!\/)>$/i;
const CLOSE_TAG = /^<\/([a-z][a-z0-9-]*)\s*>$/i;

const tagName = (node: Nodes, pattern: RegExp) =>
  node.type === "html" ? pattern.exec(node.value)?.[1]?.toLowerCase() : undefined;

// CommonMark splits `<kbd>Ctrl</kbd>` into tag, text, tag; one html node per run lets it render.
function groupInlineHtml(node: Nodes, source: string) {
  if (!("children" in node)) return;
  node.children.forEach((child) => groupInlineHtml(child, source));
  if (node.type === "root") return;
  const children: Nodes[] = node.children;
  for (let index = 0; index < children.length; index++) {
    const open = children[index]!;
    const tag = tagName(open, OPEN_TAG);
    if (!tag) continue;
    let depth = 0;
    const end = children.findIndex((child, position) => {
      if (position <= index) return false;
      if (tagName(child, OPEN_TAG) === tag) depth++;
      return tagName(child, CLOSE_TAG) === tag && depth-- === 0;
    });
    const start = open.position?.start;
    const stop = end < 0 ? undefined : children[end]!.position?.end;
    // A run across lines would carry list or quote prefixes from the source.
    if (start?.offset === undefined || stop?.offset === undefined || start.line !== stop.line) {
      continue;
    }
    children.splice(index, end - index + 1, {
      type: "html",
      value: source.slice(start.offset, stop.offset),
      position: { start, end: stop },
    });
  }
}

export const inlineHtmlRemark = $remark(
  "groupInlineHtml",
  () => () => (tree: Root, file: { value: unknown }) => {
    if (typeof file.value === "string") groupInlineHtml(tree, file.value);
  },
);
