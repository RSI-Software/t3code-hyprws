import { type Editor, remarkStringifyOptionsCtx } from "@milkdown/core";
import { clipboard } from "@milkdown/plugin-clipboard";
import { history } from "@milkdown/plugin-history";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";

import { frontmatterRemark, frontmatterSchema } from "./markdownFrontmatter";
import { markdownMath } from "./markdownMath.fork";
import { codeBlockMetaSchema } from "./markdownSyntax.fork";
import { bulletListSpreadFix, listItemSpreadFix } from "./markdownSerializerFixes";
import { preserveTableDelimiter } from "./markdownTableDelimiter.fork";

// Keep the editor and round-trip tests on one plugin chain. New syntax support
// belongs here so it cannot ship without passing through the preservation suite.
export function markdownPipeline(editor: Editor): Editor {
  return editor
    .config((ctx) => {
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options,
        bullet: "-" as const,
        rule: "-" as const,
        handlers: { ...options.handlers, table: preserveTableDelimiter },
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(codeBlockMetaSchema)
    .use(markdownMath)
    .use(bulletListSpreadFix)
    .use(listItemSpreadFix)
    .use(frontmatterRemark)
    .use(frontmatterSchema)
    .use(history)
    .use(clipboard);
}
