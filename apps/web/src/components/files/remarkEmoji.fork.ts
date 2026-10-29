import { nameToEmoji } from "gemoji";
import type { Literal, Nodes, Root } from "mdast";
import { literalChars, type SourceFile, sliceText } from "./remarkEscapes.fork";

/** A GitHub `:name:` shortcode; `value` holds the emoji, so it renders as plain text. */
export interface Emoji extends Literal {
  type: "emoji";
  name: string;
}

declare module "mdast" {
  interface PhrasingContentMap {
    emoji: Emoji;
  }
  interface RootContentMap {
    emoji: Emoji;
  }
}

const SHORTCODE = /:([\w+-]+):/g;

export const emojiFor = (name: string): string | undefined =>
  Object.hasOwn(nameToEmoji, name) ? nameToEmoji[name] : undefined;

function shortcodes(node: Nodes, file?: SourceFile) {
  if (!("children" in node)) return;
  node.children = node.children.flatMap((child): Nodes[] => {
    if (child.type !== "text") {
      shortcodes(child, file);
      return [child];
    }
    const literal = literalChars(child, file);
    const parts: Nodes[] = [];
    let from = 0;
    for (const match of child.value.matchAll(SHORTCODE)) {
      const name = match[1]!;
      const emoji = emojiFor(name);
      if (!emoji || literal?.[match.index]) continue;
      if (match.index > from) parts.push(sliceText(child, literal, from, match.index));
      parts.push({ type: "emoji", name, value: emoji });
      from = match.index + match[0].length;
    }
    if (!parts.length) return [child];
    if (from < child.value.length) parts.push(sliceText(child, literal, from));
    return parts;
  }) as typeof node.children;
}

/** Parses GitHub `:name:` shortcodes into `emoji` nodes; an escaped leading `:` keeps one as text. */
export const remarkEmoji = () => (tree: Root, file?: SourceFile) => shortcodes(tree, file);
