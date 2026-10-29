import type { Nodes, Parent, PhrasingContent, Root, Text } from "mdast";
import { literalChars, type SourceFile, sliceText } from "./remarkEscapes.fork";

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
// can span siblings, as in `==a **b**==`. An escaped `=` in either marker keeps it text.
const OPEN = /==(?:(?=\S)|$)/g;

const active = (literal: boolean[] | undefined, index: number) =>
  !literal?.[index] && !literal?.[index + 1];

function openAt(value: string, literal: boolean[] | undefined): number {
  for (const match of value.matchAll(OPEN)) if (active(literal, match.index)) return match.index;
  return -1;
}

function closeAt(value: string, from: number, literal: boolean[] | undefined): number {
  for (let index = value.indexOf("==", from); index >= 0; index = value.indexOf("==", index + 1)) {
    if ((index === 0 || /\S/.test(value[index - 1]!)) && active(literal, index)) return index;
  }
  return -1;
}

function highlightRuns(children: Nodes[], file?: SourceFile) {
  for (let index = 0; index < children.length; index++) {
    const open = children[index]!;
    if (open.type !== "text") {
      if ("children" in open) highlightRuns(open.children, file);
      continue;
    }
    if (!open.value.includes("==")) continue;
    const literal = literalChars(open, file);
    const start = openAt(open.value, literal);
    if (start < 0) continue;
    let last = index;
    let end = closeAt(open.value, start + 3, literal);
    while (end < 0 && ++last < children.length) {
      const child = children[last]!;
      if (child.type === "text") end = closeAt(child.value, 0, literalChars(child, file));
    }
    if (end < 0) continue;
    const close = children[last] as Text;
    const closeLiteral = last === index ? literal : literalChars(close, file);
    const inner =
      last === index
        ? [sliceText(open, literal, start + 2, end)]
        : [
            sliceText(open, literal, start + 2),
            ...children.slice(index + 1, last),
            sliceText(close, closeLiteral, 0, end),
          ];
    const highlight = {
      type: "highlight",
      data: { hName: "mark" },
      children: inner.filter((node) => node.type !== "text" || node.value),
    } as Highlight;
    highlightRuns(highlight.children, file);
    const head = sliceText(open, literal, 0, start);
    const tail = sliceText(close, closeLiteral, end + 2);
    children.splice(
      index,
      last - index + 1,
      ...(head.value ? [head] : []),
      highlight,
      ...(tail.value ? [tail] : []),
    );
    if (head.value) index++;
  }
}

/** Parses `==text==` into a `highlight` node that renders as `<mark>`. */
export const remarkHighlight = () => (tree: Root, file?: SourceFile) =>
  highlightRuns(tree.children, file);
