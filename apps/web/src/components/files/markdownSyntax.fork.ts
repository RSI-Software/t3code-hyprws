import { codeBlockSchema } from "@milkdown/preset-commonmark";

// Fence info after the language (`title="app.ts"`) has no ProseMirror home upstream, so an edit
// anywhere in the file would drop it.
export const codeBlockMetaSchema = codeBlockSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, meta: { default: "", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.openNode(type, { language: node["lang"] ?? "", meta: node["meta"] ?? "" });
        if (typeof node["value"] === "string" && node["value"]) state.addText(node["value"]);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.addNode("code", undefined, node.content.firstChild?.text || "", {
          lang: node.attrs["language"],
          meta: node.attrs["meta"] || null,
        });
      },
    },
  };
});

/** The `title="…"` value of a fence's info string, which GitHub and docs sites show as a caption. */
export function codeBlockTitle(meta: string): string | null {
  return /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta)?.slice(1).find(Boolean) ?? null;
}
