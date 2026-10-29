import type { Text } from "mdast";
import type { Data } from "unified";

declare module "mdast" {
  interface TextData {
    literal?: boolean[];
  }
}

/** The processed file; `value` is the Markdown source the node positions index. */
export type SourceFile = { value?: unknown };

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/y;

/**
 * Flags the characters of `node.value` that a `\x` escape or an entity produced in the source, so
 * plugins can leave them as text. Undefined when the source is unknown or holds neither.
 */
export function literalChars(node: Text, file?: SourceFile): boolean[] | undefined {
  if (node.data?.literal) return node.data.literal;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof file?.value !== "string" || start === undefined || end === undefined) return;
  const raw = file.value.slice(start, end);
  if (!/[\\&]/.test(raw)) return;
  const { value } = node;
  const literal: boolean[] = [];
  let at = 0;
  // Source characters with no match in the value are line prefixes and stripped whitespace.
  for (let index = 0; index < value.length; at++) {
    if (at >= raw.length) return;
    const char = value[index]!;
    if (raw[at] === "\\" && raw[at + 1] === char && PUNCTUATION.test(char)) {
      literal[index++] = true;
      at++;
      continue;
    }
    ENTITY.lastIndex = at;
    const entity = raw[at] === "&" ? ENTITY.exec(raw)?.[0] : undefined;
    if (entity && !value.startsWith(entity, index)) {
      const width = value.codePointAt(index)! > 0xffff ? 2 : 1;
      for (const stop = index + width; index < stop; index++) literal[index] = true;
      at += entity.length - 1;
      continue;
    }
    if (raw[at] === char) index++;
  }
  return literal;
}

/** `node.value.slice(from, to)` as a text node that keeps its literal flags. */
export function sliceText(
  node: Text,
  literal: boolean[] | undefined,
  from: number,
  to?: number,
): Text {
  const value = node.value.slice(from, to);
  return literal
    ? { type: "text", value, data: { literal: literal.slice(from, to) } }
    : { type: "text", value };
}

type Unsafe = NonNullable<NonNullable<Data["toMarkdownExtensions"]>[number]["unsafe"]>[number];

/** Saves an escape before `character` in text when the `after` lookahead says it would open syntax. */
export const escapeOpener = (character: string, after: string): Unsafe => ({
  character,
  after,
  inConstruct: "phrasing",
  notInConstruct: [
    "autolink",
    "destinationLiteral",
    "destinationRaw",
    "reference",
    "titleQuote",
    "titleApostrophe",
  ],
});
