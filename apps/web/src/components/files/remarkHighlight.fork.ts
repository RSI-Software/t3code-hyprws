import type { Nodes, Parent, PhrasingContent, Root } from "mdast";

export interface Highlight extends Parent {
  type: "highlight";
  children: PhrasingContent[];
}

declare module "mdast" {
  interface PhrasingContentMap {
    highlight: Highlight;
  }
  interface RootContentMap {
    highlight: Highlight;
  }
}

// Obsidian's `==text==`: no space just inside either marker, so `a == b == c` stays text. A run
// can span siblings, as in `==a **b**==`.
const OPEN = /==(?:(?=\S)|$)/;

const text = (value: string): Nodes => ({ type: "text", value });

function closeAt(value: string, from: number): number {
  for (let index = value.indexOf("==", from); index >= 0; index = value.indexOf("==", index + 1)) {
    if (index === 0 || /\S/.test(value[index - 1]!)) return index;
  }
  return -1;
}

function highlightRuns(children: Nodes[]) {
  for (let index = 0; index < children.length; index++) {
    const open = children[index]!;
    if (open.type !== "text") {
      if ("children" in open) highlightRuns(open.children);
      continue;
    }
    const start = open.value.search(OPEN);
    if (start < 0) continue;
    let last = index;
    let end = closeAt(open.value, start + 3);
    while (end < 0 && ++last < children.length) {
      const child = children[last]!;
      if (child.type === "text") end = closeAt(child.value, 0);
    }
    if (end < 0) continue;
    const close = children[last] as Extract<Nodes, { type: "text" }>;
    const inner =
      last === index
        ? [text(open.value.slice(start + 2, end))]
        : [
            text(open.value.slice(start + 2)),
            ...children.slice(index + 1, last),
            text(close.value.slice(0, end)),
          ];
    const highlight = {
      type: "highlight",
      data: { hName: "mark" },
      children: inner.filter((node) => node.type !== "text" || node.value),
    } as Highlight;
    highlightRuns(highlight.children);
    const head = open.value.slice(0, start);
    const tail = close.value.slice(end + 2);
    children.splice(
      index,
      last - index + 1,
      ...(head ? [text(head)] : []),
      highlight,
      ...(tail ? [text(tail)] : []),
    );
    if (head) index++;
  }
}

/** Parses `==text==` into a `highlight` node that renders as `<mark>`. */
export const remarkHighlight = () => (tree: Root) => highlightRuns(tree.children);
