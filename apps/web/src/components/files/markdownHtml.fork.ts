import type { MilkdownPlugin } from "@milkdown/ctx";
import { $nodeSchema, $remark } from "@milkdown/utils";
import type { BlockContent, Nodes, Parent, Root } from "mdast";
import { Tokenizer, TokenizerMode } from "parse5";
import type { Data, Processor } from "unified";

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const OPTIONAL_END_HTML_TAGS = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "option",
  "optgroup",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "colgroup",
  "caption",
  "rt",
  "rp",
]);

// The tree builder, not the tokenizer, switches into raw-text states, so the scanner must too.
const RAW_TEXT_MODES: ReadonlyMap<string, Tokenizer["state"]> = new Map([
  ["iframe", TokenizerMode.RAWTEXT],
  ["noembed", TokenizerMode.RAWTEXT],
  ["noframes", TokenizerMode.RAWTEXT],
  ["noscript", TokenizerMode.RAWTEXT],
  ["plaintext", TokenizerMode.PLAINTEXT],
  ["script", TokenizerMode.SCRIPT_DATA],
  ["style", TokenizerMode.RAWTEXT],
  ["textarea", TokenizerMode.RCDATA],
  ["title", TokenizerMode.RCDATA],
  ["xmp", TokenizerMode.RAWTEXT],
]);

const EOF_PARSE_ERRORS = new Set([
  "eof-in-tag",
  "eof-in-comment",
  "eof-in-doctype",
  "eof-in-cdata",
]);

/** The elements an HTML fragment leaves open, or null when it closes one it never opened. */
function unclosedHtmlTags(value: string): string[] | null {
  const open: string[] = [];
  let valid = true;
  const ignore = () => {};
  const tokenizer: Tokenizer = new Tokenizer(
    {},
    {
      onStartTag({ tagName, selfClosing }) {
        const mode = RAW_TEXT_MODES.get(tagName);
        if (mode !== undefined) tokenizer.state = mode;
        if (!selfClosing && !VOID_HTML_TAGS.has(tagName)) open.push(tagName);
      },
      onEndTag({ tagName }) {
        while (
          open.length > 0 &&
          open.at(-1) !== tagName &&
          OPTIONAL_END_HTML_TAGS.has(open.at(-1)!)
        ) {
          open.pop();
        }
        if (open.pop() !== tagName) valid = false;
      },
      onParseError({ code }) {
        if (EOF_PARSE_ERRORS.has(code)) valid = false;
      },
      onComment: ignore,
      onDoctype: ignore,
      onEof: ignore,
      onCharacter: ignore,
      onNullCharacter: ignore,
      onWhitespaceCharacter: ignore,
    },
  );
  tokenizer.write(value, true);
  return valid ? open.filter((tag) => !OPTIONAL_END_HTML_TAGS.has(tag)) : null;
}

export const isBalancedHtml = (value: string) => unclosedHtmlTags(value)?.length === 0;

const CLOSE_TAG = /^<\/([a-z][a-z0-9-]*)\s*>$/i;

// Milkdown wraps each block of raw HTML in a paragraph of its own.
const htmlValue = (node: Nodes) => {
  const html = node.type === "paragraph" && node.children.length === 1 ? node.children[0]! : node;
  return html.type === "html" ? html.value : undefined;
};

const openedTag = (node: Nodes) => {
  const value = htmlValue(node);
  const tags = value === undefined ? null : unclosedHtmlTags(value);
  return tags?.length === 1 ? tags[0] : undefined;
};

const closedTag = (node: Nodes) =>
  CLOSE_TAG.exec(htmlValue(node)?.trim() ?? "")?.[1]?.toLowerCase();

const FLOW_PARENTS = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
  "htmlContainer",
]);

interface HtmlContainer extends Parent {
  type: "htmlContainer";
  open: string;
  close: string;
  children: BlockContent[];
}

declare module "mdast" {
  interface RootContentMap {
    htmlContainer: HtmlContainer;
  }
}

/**
 * CommonMark splits `<kbd>Ctrl</kbd>` into tag, text, tag, and a `<details>` with blank lines
 * into open tag, Markdown, close tag. Inline runs become one html node so they render; block
 * runs become a container whose Markdown stays editable.
 */
function groupHtml(node: Nodes, source: string) {
  if (!("children" in node)) return;
  const children: Nodes[] = node.children;
  const flow = FLOW_PARENTS.has(node.type);
  for (let index = 0; index < children.length; index++) {
    const open = children[index]!;
    const tag = openedTag(open);
    if (!tag) continue;
    let depth = 0;
    const end = children.findIndex((child, position) => {
      if (position <= index) return false;
      if (openedTag(child) === tag) depth++;
      return closedTag(child) === tag && depth-- === 0;
    });
    if (end < 0) continue;
    const close = children[end]!;
    // An inline run across lines would carry list or quote prefixes from the source.
    const start = open.position?.start;
    const stop = close.position?.end;
    if (flow) {
      if (end === index + 1) continue;
      const container: HtmlContainer = {
        type: "htmlContainer",
        open: htmlValue(open)!,
        close: htmlValue(close)!,
        children: children.slice(index + 1, end) as BlockContent[],
      };
      children.splice(index, end - index + 1, container);
    } else if (
      start?.offset !== undefined &&
      stop?.offset !== undefined &&
      start.line === stop.line
    ) {
      children.splice(index, end - index + 1, {
        type: "html",
        value: source.slice(start.offset, stop.offset),
        position: { start, end: stop },
      });
    }
  }
  children.forEach((child) => groupHtml(child, source));
}

type Handlers = NonNullable<NonNullable<Data["toMarkdownExtensions"]>[number]["handlers"]>;

const writeHtmlContainer: NonNullable<Handlers["htmlContainer"]> = (
  node: HtmlContainer,
  _parent,
  state,
  info,
) => `${node.open}\n\n${state.containerFlow(node, info)}\n\n${node.close}`;

function remarkGroupHtml(this: Processor) {
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push({ handlers: { htmlContainer: writeHtmlContainer } });
  return (tree: Root, file: { value: unknown }) => {
    if (typeof file.value === "string") groupHtml(tree, file.value);
  };
}

const htmlRemark = $remark("remarkGroupHtml", () => remarkGroupHtml);

export const htmlContainerSchema = $nodeSchema("html_container", () => ({
  group: "block",
  content: "block+",
  defining: true,
  attrs: { open: { default: "", validate: "string" }, close: { default: "", validate: "string" } },
  parseDOM: [
    {
      tag: "div[data-type=html_container]",
      getAttrs: (dom: HTMLElement) => ({
        open: dom.dataset["open"] ?? "",
        close: dom.dataset["close"] ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-type": "html_container",
      "data-open": String(node.attrs["open"]),
      "data-close": String(node.attrs["close"]),
    },
    0,
  ],
  parseMarkdown: {
    match: ({ type }) => type === "htmlContainer",
    runner: (state, node, type) => {
      state
        .openNode(type, { open: node["open"], close: node["close"] })
        .next(node.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "html_container",
    runner: (state, node) => {
      state
        .openNode("htmlContainer", undefined, {
          open: node.attrs["open"],
          close: node.attrs["close"],
        })
        .next(node.content)
        .closeNode();
    },
  },
}));

export const markdownHtml: MilkdownPlugin[] = [htmlRemark, htmlContainerSchema].flat();
