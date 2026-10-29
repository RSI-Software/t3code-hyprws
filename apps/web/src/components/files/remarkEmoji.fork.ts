import { nameToEmoji } from "gemoji";
import type { Literal, Nodes, Root } from "mdast";

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

function shortcodes(node: Nodes) {
  if (!("children" in node)) return;
  node.children = node.children.flatMap((child): Nodes[] => {
    if (child.type !== "text") {
      shortcodes(child);
      return [child];
    }
    const parts: Nodes[] = [];
    let from = 0;
    for (const match of child.value.matchAll(SHORTCODE)) {
      const name = match[1]!;
      const emoji = emojiFor(name);
      if (!emoji) continue;
      if (match.index > from)
        parts.push({ type: "text", value: child.value.slice(from, match.index) });
      parts.push({ type: "emoji", name, value: emoji });
      from = match.index + match[0].length;
    }
    if (!parts.length) return [child];
    if (from < child.value.length) parts.push({ type: "text", value: child.value.slice(from) });
    return parts;
  }) as typeof node.children;
}

/** Parses GitHub `:name:` shortcodes into `emoji` nodes. */
export const remarkEmoji = () => (tree: Root) => shortcodes(tree);
