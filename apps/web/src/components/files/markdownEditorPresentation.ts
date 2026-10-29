import type { MilkdownPlugin } from "@milkdown/ctx";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import { codeBlockSchema, htmlSchema, linkSchema } from "@milkdown/preset-commonmark";
import { extendListItemSchemaForTask } from "@milkdown/preset-gfm";
import { $prose, $view } from "@milkdown/utils";
import { scopeMarkdownCss } from "@t3tools/shared/markdownStyledHtml.fork";
import DOMPurify from "dompurify";

import { resolvePierreIconColor } from "~/components/chat/PierreEntryIcon";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import {
  ensurePierreIconSprite,
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
} from "~/pierre-icons";
import { htmlContainerSchema, isBalancedHtml } from "./markdownHtml.fork";
import { markdownMathViews } from "./markdownMath.fork";
import { renderMermaid } from "./markdownMermaid.fork";
import { codeBlockTitle } from "./markdownSyntax.fork";
import { resolveRichMarkdownEditorLinkMeta } from "./richMarkdownEditorLinks";

// The chat file-mention chip look, owned here because the editor decorates raw DOM and
// cannot render the React chip component.
const FILE_LINK_CHIP_CLASS_NAME =
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] px-[0.5em] font-medium leading-none align-middle border border-border/70 bg-accent/40 text-foreground text-[12px] border-[color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] bg-[color-mix(in_oklab,var(--context-chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] [--context-chip-accent:oklch(0.62_0.11_215)]";

interface MarkdownEditorPresentationOptions {
  readonly cwd: { current: string };
  readonly sourcePath: { current: string };
  readonly onOpenFile: { current: (relativePath: string) => void };
  readonly theme: { current: "light" | "dark" };
}

interface HighlightState {
  readonly decorations: DecorationSet;
  readonly revision: number;
}

type HighlightMeta =
  | { readonly type: "decorations"; readonly decorations: DecorationSet }
  | { readonly type: "refresh" };

const codeHighlightKey = new PluginKey<HighlightState>("t3-markdown-code-highlight");

function documentDirectory(workspaceRoot: string, sourcePath: string): string {
  const normalizedPath = sourcePath.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return workspaceRoot;

  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const directory = normalizedPath.slice(0, separatorIndex).replaceAll("/", separator);
  return `${workspaceRoot.replace(/[/\\]+$/, "")}${separator}${directory}`;
}

function iconElement(path: string, theme: "light" | "dark"): SVGSVGElement | null {
  const icon = resolvePierreIconForEntry(path, "file");
  if (!icon) return null;

  ensurePierreIconSprite();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.dataset["pierreIcon"] = icon.name;
  svg.dataset["iconToken"] = icon.token ?? "default";
  svg.style.color = resolvePierreIconColor(icon.token, theme);

  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${icon.name}`);
  svg.append(use);
  return svg;
}

function taskListItemView() {
  return $view(extendListItemSchemaForTask.node, () => (initialNode, editorView, getPos) => {
    let node = initialNode;
    const dom = document.createElement("li");
    const isTask = node.attrs["checked"] !== null;
    const contentDOM = isTask ? document.createElement("div") : dom;
    let checkbox: HTMLInputElement | null = null;

    if (isTask) {
      dom.dataset["itemType"] = "task";
      dom.dataset["checked"] = String(Boolean(node.attrs["checked"]));
      checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(node.attrs["checked"]);
      checkbox.setAttribute("aria-label", "Toggle task");
      checkbox.setAttribute("contenteditable", "false");
      checkbox.addEventListener("change", () => {
        const position = getPos();
        if (typeof position !== "number" || !checkbox) return;
        editorView.dispatch(
          editorView.state.tr.setNodeMarkup(position, undefined, {
            ...node.attrs,
            checked: checkbox.checked,
          }),
        );
      });
      dom.append(checkbox, contentDOM);
    }

    return {
      dom,
      contentDOM,
      update(nextNode) {
        if (nextNode.type !== node.type) return false;
        if ((nextNode.attrs["checked"] !== null) !== isTask) return false;
        node = nextNode;
        if (checkbox) {
          checkbox.checked = Boolean(node.attrs["checked"]);
          dom.dataset["checked"] = String(checkbox.checked);
        }
        return true;
      },
      stopEvent(event) {
        return event.target === checkbox;
      },
      ignoreMutation(mutation) {
        return mutation.target === checkbox;
      },
    };
  });
}

function codeBlockView(theme: MarkdownEditorPresentationOptions["theme"]) {
  return $view(codeBlockSchema.node, () => (initialNode, view, getPos) => {
    let node = initialNode;
    const dom = document.createElement("div");
    dom.className = "t3-markdown-editor__codeblock";

    const header = document.createElement("div");
    header.className = "t3-markdown-editor__codeblock-header";
    header.setAttribute("contenteditable", "false");

    const languageLabel = document.createElement("span");
    languageLabel.className = "t3-markdown-editor__codeblock-language";
    const languageText = document.createElement("span");
    languageLabel.append(languageText);

    const copyButton = document.createElement("button");
    copyButton.className = "t3-markdown-editor__codeblock-copy";
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.setAttribute("aria-label", "Copy code");

    const pre = document.createElement("pre");
    const contentDOM = document.createElement("code");
    pre.append(contentDOM);
    header.append(languageLabel, copyButton);
    dom.append(header, pre);
    const diagram = isMermaid(node) ? mermaidPreview(dom, view, getPos) : null;
    diagram?.render(node.textContent);

    const renderLanguage = () => {
      const language = String(node.attrs["language"] || "text");
      dom.dataset["language"] = language;
      languageText.textContent = codeBlockTitle(String(node.attrs["meta"] ?? "")) ?? language;
      languageLabel.querySelector("svg")?.remove();
      const icon = iconElement(syntheticFileNameForLanguageId(language), theme.current);
      if (icon) languageLabel.prepend(icon);
    };
    renderLanguage();

    copyButton.addEventListener("click", () => {
      void navigator.clipboard?.writeText(node.textContent).then(() => {
        copyButton.textContent = "Copied";
        window.setTimeout(() => {
          copyButton.textContent = "Copy";
        }, 1200);
      });
    });

    return {
      dom,
      contentDOM,
      update(nextNode) {
        if (nextNode.type !== node.type || isMermaid(nextNode) !== isMermaid(node)) return false;
        const labelChanged =
          nextNode.attrs["language"] !== node.attrs["language"] ||
          nextNode.attrs["meta"] !== node.attrs["meta"];
        node = nextNode;
        if (labelChanged) renderLanguage();
        diagram?.render(node.textContent);
        return true;
      },
      stopEvent(event) {
        return (
          event.target === copyButton || diagram?.element.contains(event.target as Node) === true
        );
      },
      ignoreMutation(mutation) {
        return (
          header.contains(mutation.target) || diagram?.element.contains(mutation.target) === true
        );
      },
      destroy() {
        diagram?.destroy();
      },
    };
  });
}

const isMermaid = (node: ProseNode) => node.attrs["language"] === "mermaid";

// Shows the diagram, and its source only while the caret is in it (see markdownMathViews).
function mermaidPreview(dom: HTMLElement, view: EditorView, getPos: () => number | undefined) {
  const element = document.createElement("div");
  element.className = "t3-markdown-editor__codeblock-diagram";
  element.contentEditable = "false";
  dom.append(element);
  dom.classList.add("t3-markdown-editor__codeblock--diagram");

  element.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const position = getPos();
    if (position === undefined) return;
    const end = position + view.state.doc.nodeAt(position)!.nodeSize - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    view.focus();
  });

  let source: string | null = null;
  let cleanup = () => {};
  let timer: number | undefined;
  const draw = (next: string) => {
    cleanup();
    element.replaceChildren();
    cleanup = renderMermaid(element, next, (invalid) => {
      element.classList.toggle("is-invalid", invalid);
    });
  };
  const render = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === source) return;
    const first = source === null;
    source = trimmed;
    window.clearTimeout(timer);
    // Typing re-lays the diagram out, so wait for a pause.
    if (first) draw(trimmed);
    else timer = window.setTimeout(() => draw(trimmed), 250);
  };
  return {
    element,
    render,
    destroy() {
      window.clearTimeout(timer);
      cleanup();
    },
  };
}

const HTML_SCOPE_CLASS_NAME = "t3-markdown-editor__html-content";

// Top-layer attributes would let an island escape `contain: paint` and cover the app.
const TOP_LAYER_ATTRIBUTES = [
  "popover",
  "popovertarget",
  "popovertargetaction",
  "command",
  "commandfor",
  "interestfor",
];

// `contain: paint` needs a block box, so inline islands drop every hook styles could position.
const INLINE_FORBIDDEN_ATTRIBUTES = [...TOP_LAYER_ATTRIBUTES, "class", "id", "style"];

function renderedHtml(value: string, inline: boolean): DocumentFragment | null {
  if (!isBalancedHtml(value)) return null;
  const fragment = DOMPurify.sanitize(value, {
    RETURN_DOM_FRAGMENT: true,
    FORCE_BODY: true,
    FORBID_ATTR: inline ? INLINE_FORBIDDEN_ATTRIBUTES : TOP_LAYER_ATTRIBUTES,
    FORBID_TAGS: inline ? ["style"] : [],
  });
  if (!fragment.hasChildNodes()) return null;
  fragment.querySelectorAll("style").forEach((style) => {
    style.textContent = scopeMarkdownCss(style.textContent ?? "", `.${HTML_SCOPE_CLASS_NAME}`);
  });
  return fragment;
}

/**
 * Renders balanced raw HTML as a sanitized island, inline when it shares its paragraph; a lone
 * open or close tag stays source text. Every island's content is an `@scope` root for every island's styles,
 * so a `<style>` block reaches markup in later blocks. The outer element is outside every scope,
 * so its `contain: paint` keeps fixed-position content from covering the app.
 */
function htmlView() {
  return $view(htmlSchema.node, () => (node, editorView, getPos) => {
    const value = String(node.attrs["value"] ?? "");
    const position = getPos();
    const parent =
      typeof position === "number" ? editorView.state.doc.resolve(position).parent : null;
    const inline = parent?.childCount !== 1;
    const fragment = renderedHtml(value, inline);
    const dom = document.createElement("span");
    dom.dataset["type"] = "html";
    if (fragment && inline) {
      dom.className = "t3-markdown-editor__html--inline";
      dom.append(fragment);
    } else if (fragment) {
      const content = document.createElement("span");
      content.className = HTML_SCOPE_CLASS_NAME;
      content.append(fragment);
      dom.className = "t3-markdown-editor__html";
      dom.style.contain = "paint";
      dom.append(content);
    }
    if (fragment) {
      // Anchors and forms in a non-editable island would navigate the app window.
      dom.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
      });
      dom.addEventListener("submit", (event) => event.preventDefault());
    } else {
      dom.textContent = value;
    }

    return {
      dom,
      update: (nextNode) => nextNode.type === node.type && nextNode.attrs["value"] === value,
      ignoreMutation: () => true,
    };
  });
}

/** Renders a split HTML block's tags around its editable Markdown, e.g. a `<details>` summary. */
function htmlContainerView() {
  return $view(htmlContainerSchema.node, () => (node) => {
    const dom = document.createElement("div");
    dom.className = "t3-markdown-editor__html";
    dom.style.contain = "paint";
    const contentDOM = document.createElement("div");
    const open = String(node.attrs["open"]);
    const close = String(node.attrs["close"]);
    const fragment = renderedHtml(open + close, false);
    const element = fragment?.childElementCount === 1 ? fragment.firstElementChild : null;
    if (fragment && element) {
      for (const child of Array.from(element.childNodes)) {
        const chrome = child instanceof HTMLElement ? child : document.createElement("span");
        if (chrome !== child) {
          child.replaceWith(chrome);
          chrome.append(child);
        }
        chrome.contentEditable = "false";
      }
      element.append(contentDOM);
      const content = document.createElement("div");
      content.className = HTML_SCOPE_CLASS_NAME;
      content.append(fragment);
      dom.append(content);
    } else {
      const source = (value: string) =>
        Object.assign(document.createElement("div"), {
          textContent: value,
          contentEditable: "false",
        });
      dom.append(source(open), contentDOM, source(close));
    }
    return {
      dom,
      contentDOM,
      update: (nextNode) =>
        nextNode.type === node.type &&
        nextNode.attrs["open"] === open &&
        nextNode.attrs["close"] === close,
      // Toggling a `<details>` changes its attributes, outside the editable content.
      ignoreMutation: (mutation) =>
        mutation.type !== "selection" && !contentDOM.contains(mutation.target),
    };
  });
}

function linkView(options: MarkdownEditorPresentationOptions) {
  return $view(linkSchema.mark, () => (initialMark) => {
    let mark = initialMark;
    const dom = document.createElement("a");
    const contentDOM = document.createElement("span");
    const iconSlot = document.createElement("span");
    iconSlot.className = "t3-markdown-editor__file-icon";

    const render = () => {
      const href = String(mark.attrs["href"] ?? "");
      const title = mark.attrs["title"];
      const file = resolveRichMarkdownEditorLinkMeta(
        href,
        options.cwd.current,
        documentDirectory(options.cwd.current, options.sourcePath.current),
      );
      dom.setAttribute("href", href);
      if (typeof title === "string") dom.setAttribute("title", title);
      else dom.removeAttribute("title");

      dom.className = "";
      contentDOM.className = "";
      iconSlot.replaceChildren();
      if (!file?.workspaceRelativePath) return;

      dom.className = `${FILE_LINK_CHIP_CLASS_NAME} t3-markdown-editor__file-link`;
      // The label truncates to the chip, as the chat chip's label does.
      contentDOM.className = "min-w-0 truncate";
      dom.dataset["filePath"] = file.workspaceRelativePath;
      dom.title = file.displayPath;
      const icon = iconElement(file.filePath, options.theme.current);
      if (icon) iconSlot.append(icon);
    };
    render();
    dom.append(iconSlot, contentDOM);

    dom.addEventListener("click", (event) => {
      const relativePath = dom.dataset["filePath"];
      if (!relativePath) return;
      event.preventDefault();
      event.stopPropagation();
      options.onOpenFile.current(relativePath);
    });

    return {
      dom,
      contentDOM,
      update(nextMark) {
        if (nextMark.type !== mark.type) return false;
        mark = nextMark;
        render();
        return true;
      },
    };
  });
}

function codeTokenStyle(token: {
  readonly color?: string | undefined;
  readonly fontStyle?: number | undefined;
}): string {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 1) styles.push("font-style:italic");
  if (fontStyle & 2) styles.push("font-weight:700");
  if (fontStyle & 4) styles.push("text-decoration:underline");
  return styles.join(";");
}

async function codeDecorations(doc: ProseNode, theme: "light" | "dark"): Promise<DecorationSet> {
  const blocks: Array<{ readonly node: ProseNode; readonly position: number }> = [];
  doc.descendants((node, position) => {
    if (node.type.name === "code_block") blocks.push({ node, position });
  });

  const blockDecorations = await Promise.all(
    blocks.map(async ({ node, position }) => {
      const code = node.textContent;
      const language = String(node.attrs["language"] || "text");
      try {
        const highlighter = await getSyntaxHighlighterPromise(language);
        const result = highlighter.codeToTokens(code, {
          lang: language,
          theme: resolveDiffThemeName(theme),
        });
        const decorations: Decoration[] = [];
        for (const tokens of result.tokens) {
          for (const token of tokens) {
            const style = codeTokenStyle(token);
            if (!style || token.content.length === 0) continue;
            const from = position + 1 + token.offset;
            decorations.push(Decoration.inline(from, from + token.content.length, { style }));
          }
        }
        return decorations;
      } catch {
        return [];
      }
    }),
  );

  return DecorationSet.create(doc, blockDecorations.flat());
}

function syntaxHighlighting(theme: MarkdownEditorPresentationOptions["theme"]) {
  return $prose(
    () =>
      new Plugin<HighlightState>({
        key: codeHighlightKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, revision: 0 }),
          apply(transaction, previous) {
            const meta = transaction.getMeta(codeHighlightKey) as HighlightMeta | undefined;
            if (meta?.type === "decorations") {
              return { ...previous, decorations: meta.decorations };
            }
            if (meta?.type === "refresh") {
              return { decorations: DecorationSet.empty, revision: previous.revision + 1 };
            }
            return {
              ...previous,
              decorations: previous.decorations.map(transaction.mapping, transaction.doc),
            };
          },
        },
        props: {
          decorations: (state) => codeHighlightKey.getState(state)?.decorations,
        },
        view(editorView) {
          let request = 0;
          let destroyed = false;
          const refresh = (view: EditorView) => {
            const currentRequest = ++request;
            const doc = view.state.doc;
            void codeDecorations(doc, theme.current).then((decorations) => {
              if (destroyed || currentRequest !== request || view.state.doc !== doc) return;
              view.dispatch(
                view.state.tr
                  .setMeta(codeHighlightKey, {
                    type: "decorations",
                    decorations,
                  } satisfies HighlightMeta)
                  .setMeta("addToHistory", false),
              );
            });
          };
          refresh(editorView);

          return {
            update(view, previousState) {
              const previous = codeHighlightKey.getState(previousState);
              const current = codeHighlightKey.getState(view.state);
              if (
                !view.state.doc.eq(previousState.doc) ||
                current?.revision !== previous?.revision
              ) {
                refresh(view);
              }
            },
            destroy() {
              destroyed = true;
              request += 1;
            },
          };
        },
      }),
  );
}

export function markdownEditorPresentation(
  options: MarkdownEditorPresentationOptions,
): MilkdownPlugin[] {
  return [
    taskListItemView(),
    codeBlockView(options.theme),
    htmlView(),
    htmlContainerView(),
    linkView(options),
    syntaxHighlighting(options.theme),
    ...markdownMathViews(),
  ];
}

export function refreshMarkdownEditorPresentation(
  editorView: EditorView,
  theme: "light" | "dark",
): void {
  editorView.dom.querySelectorAll<SVGSVGElement>("svg[data-icon-token]").forEach((icon) => {
    icon.style.color = resolvePierreIconColor(icon.dataset["iconToken"], theme);
  });
  editorView.dispatch(
    editorView.state.tr
      .setMeta(codeHighlightKey, { type: "refresh" } satisfies HighlightMeta)
      .setMeta("addToHistory", false),
  );
}
