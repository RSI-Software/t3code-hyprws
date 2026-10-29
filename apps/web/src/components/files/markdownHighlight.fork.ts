import type { MilkdownPlugin } from "@milkdown/ctx";
import { $markSchema, $remark } from "@milkdown/utils";
import type { Data, Processor } from "unified";
import { type Highlight, remarkHighlight } from "./remarkHighlight.fork";

type Handlers = NonNullable<NonNullable<Data["toMarkdownExtensions"]>[number]["handlers"]>;

const writeHighlight: NonNullable<Handlers["highlight"]> = (
  node: Highlight,
  _parent,
  state,
  info,
) => `==${state.containerPhrasing(node, { ...info, before: "=", after: "=" })}==`;

function remarkHighlightMarkdown(this: Processor) {
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push({ handlers: { highlight: writeHighlight } });
  return remarkHighlight();
}

const highlightRemark = $remark("remarkHighlight", () => remarkHighlightMarkdown);

const highlightSchema = $markSchema("highlight", () => ({
  // Opens before other marks, so `==**b**==` does not become `**==b==**`.
  priority: 40,
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0],
  parseMarkdown: {
    match: (node) => node.type === "highlight",
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "highlight",
    runner: (state, mark) => {
      state.withMark(mark, "highlight");
    },
  },
}));

export const markdownHighlight: MilkdownPlugin[] = [highlightRemark, highlightSchema].flat();
