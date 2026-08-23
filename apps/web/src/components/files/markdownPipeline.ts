import type { Editor } from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";

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
