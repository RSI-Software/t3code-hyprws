import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { codeBlockSchema, linkSchema } from "@milkdown/kit/preset/commonmark";
import { extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";
import { $prose, $view } from "@milkdown/kit/utils";

import { CHAT_FILE_TAG_CHIP_CLASS_NAME } from "~/components/chat/FileTagChip";
import { resolvePierreIconColor } from "~/components/chat/PierreEntryIcon";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import {
  ensurePierreIconSprite,
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
} from "~/pierre-icons";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";

interface MarkdownEditorPresentationOptions {
  readonly cwd: { current: string };
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
  return $view(codeBlockSchema.node, () => (initialNode) => {
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

    const renderLanguage = () => {
      const language = String(node.attrs["language"] || "text");
      dom.dataset["language"] = language;
      languageText.textContent = language;
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
        if (nextNode.type !== node.type) return false;
        const languageChanged = nextNode.attrs["language"] !== node.attrs["language"];
        node = nextNode;
        if (languageChanged) renderLanguage();
        return true;
      },
      stopEvent(event) {
        return event.target === copyButton;
      },
      ignoreMutation(mutation) {
        return header.contains(mutation.target);
      },
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
      const file = resolveMarkdownFileLinkMeta(href, options.cwd.current);
      dom.setAttribute("href", href);
      if (typeof title === "string") dom.setAttribute("title", title);
      else dom.removeAttribute("title");

      dom.className = "";
      iconSlot.replaceChildren();
      if (!file?.workspaceRelativePath) return;

      dom.className = `${CHAT_FILE_TAG_CHIP_CLASS_NAME} t3-markdown-editor__file-link`;
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
    linkView(options),
    syntaxHighlighting(options.theme),
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
