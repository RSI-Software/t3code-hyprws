import remarkGfm from "remark-gfm";
import { unified } from "unified";

const processor = unified().use(remarkGfm);
processor.freeze();
const extensions = processor.data("toMarkdownExtensions") ?? [];
type Extension = (typeof extensions)[number];
const tableHandlers = (extension: Extension): NonNullable<Extension["handlers"]>["table"][] => [
  ...(extension.handlers?.table ? [extension.handlers.table] : []),
  ...(extension.extensions?.flatMap(tableHandlers) ?? []),
];
const tableHandler = extensions.flatMap(tableHandlers)[0]!;

// GFM allows one-dash delimiters; the repository formatter requires width three,
// including alignment colons. Extend only narrow columns of its rendered table.
export const preserveTableDelimiter: typeof tableHandler = (node, parent, state, info) => {
  const rows = tableHandler(node, parent, state, info)
    .split("\n")
    .map((row) => row.split(/(?<!\\)\|/));
  for (let column = 1; column < rows[1]!.length - 1; column++) {
    const marker = rows[1]![column]!.trim();
    if (marker.length >= 3) continue;
    const right = marker.endsWith(":");
    const center = right && marker.startsWith(":");
    rows.forEach((row, index) => {
      if (index === 1) {
        row[column] = ` ${marker.replace("-", "-".repeat(4 - marker.length))} `;
        return;
      }
      const cell = row[column]!.trim();
      const padding = 3 - cell.length;
      const before = center ? Math.ceil(padding / 2) : right ? padding : 0;
      row[column] = ` ${" ".repeat(before)}${cell}${" ".repeat(padding - before)} `;
    });
  }
  return rows.map((row) => row.join("|")).join("\n");
};
