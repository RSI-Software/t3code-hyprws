import { remarkColorSwatch } from "./colorSwatch.fork";
import { remarkEmoji } from "./remarkEmoji.fork";
import { remarkHighlight } from "./remarkHighlight.fork";

/** Syntax the file preview renders beyond chat Markdown. */
export const FILE_PREVIEW_REMARK_PLUGINS = [remarkHighlight, remarkEmoji, remarkColorSwatch];
