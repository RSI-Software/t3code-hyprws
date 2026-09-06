import type { Editor } from "@milkdown/core";
import { clipboard } from "@milkdown/plugin-clipboard";
import { history } from "@milkdown/plugin-history";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";

import { frontmatterRemark, frontmatterSchema } from "./markdownFrontmatter";
import { bulletListSpreadFix, listItemSpreadFix } from "./markdownSerializerFixes";

// Keep the editor and round-trip tests on one plugin chain. New syntax support
// belongs here so it cannot ship without passing through the preservation suite.
export function markdownPipeline(editor: Editor): Editor {
  return editor
    .use(commonmark)
    .use(gfm)
    .use(bulletListSpreadFix)
    .use(listItemSpreadFix)
    .use(frontmatterRemark)
    .use(frontmatterSchema)
    .use(history)
    .use(clipboard);
}
