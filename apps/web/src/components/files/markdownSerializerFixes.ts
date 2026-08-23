import { bulletListSchema } from "@milkdown/kit/preset/commonmark";
import { extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";

// Milkdown can deserialize the mdast `spread` boolean as a string. Passing
// "false" back to mdast is truthy and turns every tight list into a loose list.
const isSpread = (value: unknown): boolean => value === true || value === "true";

export const bulletListSpreadFix = bulletListSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.openNode("list", undefined, {
          ordered: false,
          spread: isSpread(node.attrs["spread"]),
        });
        state.next(node.content);
        state.closeNode();
      },
    },
  };
});

export const listItemSpreadFix = extendListItemSchemaForTask.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        if (node.attrs["checked"] != null) {
          base.toMarkdown.runner(state, node);
          return;
        }
        state.openNode("listItem", undefined, {
          spread: isSpread(node.attrs["spread"]),
        });
        state.next(node.content);
        state.closeNode();
      },
    },
  };
});
