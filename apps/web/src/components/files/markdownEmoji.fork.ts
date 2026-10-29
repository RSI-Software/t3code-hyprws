import type { MilkdownPlugin } from "@milkdown/ctx";
import { InputRule } from "@milkdown/prose/inputrules";
import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import type { Data, Processor } from "unified";
import { type Emoji, emojiFor, remarkEmoji } from "./remarkEmoji.fork";

type Handlers = NonNullable<NonNullable<Data["toMarkdownExtensions"]>[number]["handlers"]>;

const writeEmoji: NonNullable<Handlers["emoji"]> = (node: Emoji) => `:${node.name}:`;

function remarkEmojiMarkdown(this: Processor) {
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push({ handlers: { emoji: writeEmoji } });
  return remarkEmoji();
}

const emojiRemark = $remark("remarkEmoji", () => remarkEmojiMarkdown);

const emojiSchema = $nodeSchema("emoji", () => ({
  group: "inline",
  inline: true,
  atom: true,
  attrs: { name: { validate: "string" } },
  parseDOM: [
    {
      tag: "span[data-emoji]",
      getAttrs: (dom: HTMLElement) => ({ name: dom.dataset["emoji"] }),
    },
  ],
  toDOM: (node) => {
    const name = String(node.attrs["name"]);
    return ["span", { "data-emoji": name, title: `:${name}:` }, emojiFor(name) ?? `:${name}:`];
  },
  parseMarkdown: {
    match: ({ type }) => type === "emoji",
    runner: (state, node, type) => {
      state.addNode(type, { name: node["name"] });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "emoji",
    runner: (state, node) => {
      state.addNode("emoji", undefined, undefined, { name: node.attrs["name"] });
    },
  },
}));

const emojiInputRule = $inputRule(
  (ctx) =>
    new InputRule(/:([\w+-]+):$/, (state, match, start, end) => {
      const name = match[1]!;
      const inCode = state.doc
        .resolve(start)
        .marks()
        .some((mark) => mark.type.spec.code);
      if (inCode || !emojiFor(name)) return null;
      return state.tr.replaceWith(start, end, emojiSchema.type(ctx).create({ name }));
    }),
);

/** GitHub `:name:` shortcodes as atoms, so saving keeps the shortcode. */
export const markdownEmoji: MilkdownPlugin[] = [emojiRemark, emojiSchema, emojiInputRule].flat();
