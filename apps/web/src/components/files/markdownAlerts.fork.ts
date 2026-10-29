import type { MilkdownPlugin } from "@milkdown/ctx";
import { blockquoteSchema } from "@milkdown/preset-commonmark";
import { InputRule } from "@milkdown/prose/inputrules";
import { keymap } from "@milkdown/prose/keymap";
import { type Command, TextSelection } from "@milkdown/prose/state";
import { $inputRule, $prose, $remark } from "@milkdown/utils";
import { remarkGithubAlerts } from "@t3tools/shared/markdownGithubAlerts";
import type { Nodes, Root } from "mdast";
import {
  createElement,
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TriangleAlert,
  type IconNode,
} from "lucide";

const ALERT_TITLES: Readonly<Record<string, readonly [string, IconNode]>> = {
  note: ["Note", Info],
  tip: ["Tip", Lightbulb],
  important: ["Important", MessageSquareWarning],
  warning: ["Warning", TriangleAlert],
  caution: ["Caution", OctagonAlert],
};

const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\]$/i;

// Milkdown turns soft line breaks into `break` nodes first, which hides the line end after `[!NOTE]`.
function remarkEditorGithubAlerts() {
  const tagAlerts = remarkGithubAlerts();
  const rejoin = (node: Nodes) => {
    if (!("children" in node)) return;
    node.children.forEach(rejoin);
    const paragraph = node.type === "blockquote" ? node.children[0] : undefined;
    if (paragraph?.type !== "paragraph") return;
    const [text, lineBreak] = paragraph.children;
    if (
      text?.type === "text" &&
      ALERT_MARKER.test(text.value) &&
      lineBreak?.type === "break" &&
      (lineBreak.data as { isInline?: boolean } | undefined)?.isInline
    ) {
      text.value += "\n";
      paragraph.children.splice(1, 1);
    }
  };
  return (tree: Root) => {
    rejoin(tree);
    tagAlerts(tree as Parameters<typeof tagAlerts>[0]);
  };
}

const alertRemark = $remark("remarkGithubAlerts", () => remarkEditorGithubAlerts);

// GitHub alerts are blockquotes whose first line is `[!TYPE]`; the preview tags them with `data-alert`.
const blockquoteAlertSchema = blockquoteSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    attrs: {
      alert: { default: "", validate: "string" },
      // `> [!NOTE]` then `>` keeps the marker in its own paragraph, so a save must too.
      markerOwnLine: { default: false, validate: "boolean" },
    },
    parseDOM: [
      {
        tag: "blockquote",
        getAttrs: (dom: HTMLElement) => ({ alert: dom.dataset["alert"] ?? "" }),
        // Skip the title on copy and paste.
        contentElement: (dom: HTMLElement) =>
          dom.querySelector<HTMLElement>(":scope > .t3-markdown-editor__alert-body") ?? dom,
      },
    ],
    toDOM: (node) => {
      const alert = String(node.attrs["alert"]);
      const title = Object.hasOwn(ALERT_TITLES, alert) ? ALERT_TITLES[alert] : undefined;
      if (!title) return base.toDOM!(node);
      const [label, icon] = title;
      return [
        "blockquote",
        { "data-alert": alert },
        [
          "div",
          { class: "t3-markdown-editor__alert-title", contenteditable: "false" },
          createElement(icon, { "aria-hidden": "true" }),
          label,
        ],
        ["div", { class: "t3-markdown-editor__alert-body" }, 0],
      ];
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const alert = (node.data as { hProperties?: { dataAlert?: unknown } } | undefined)
          ?.hProperties?.dataAlert;
        const first = node.children?.[0];
        const quoteLine = node.position?.start.line ?? 0;
        const firstLine = first?.position?.start.line ?? 0;
        state
          .openNode(
            type,
            typeof alert === "string"
              ? { alert, markerOwnLine: first?.type !== "paragraph" || firstLine > quoteLine + 1 }
              : undefined,
          )
          .next(node.children)
          .closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const alert = String(node.attrs["alert"]);
        state.openNode("blockquote");
        const first = node.firstChild;
        if (!alert) {
          state.next(node.content);
        } else if (
          node.attrs["markerOwnLine"] ||
          first?.type.name !== "paragraph" ||
          first.childCount === 0
        ) {
          state.addNode("html", undefined, `[!${alert.toUpperCase()}]`).next(node.content);
        } else {
          state
            .openNode("paragraph")
            .addNode("html", undefined, `[!${alert.toUpperCase()}]\n`)
            .next(first.content)
            .closeNode()
            .next(node.content.cut(first.nodeSize));
        }
        state.closeNode();
      },
    },
  };
});

const alertInputRule = $inputRule(
  () =>
    new InputRule(/^\[!(note|tip|important|warning|caution)\]\s$/i, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      const depth = $start.depth - 1;
      const quote = $start.node(depth);
      if (quote.type.name !== "blockquote" || quote.attrs["alert"] || $start.index(depth) !== 0) {
        return null;
      }
      return state.tr
        .delete(start, end)
        .setNodeAttribute($start.before(depth), "alert", match[1]!.toLowerCase());
    }),
);

// The way back out of an alert: Backspace at its start turns it into a plain quote.
const clearAlert: Command = (state, dispatch) => {
  const $cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
  if (!$cursor || $cursor.parentOffset > 0 || $cursor.depth < 2) return false;
  const depth = $cursor.depth - 1;
  const quote = $cursor.node(depth);
  if (quote.type.name !== "blockquote" || !quote.attrs["alert"] || $cursor.index(depth) !== 0) {
    return false;
  }
  dispatch?.(state.tr.setNodeAttribute($cursor.before(depth), "alert", ""));
  return true;
};

const alertKeymap = $prose(() => keymap({ Backspace: clearAlert }));

export const markdownAlerts: MilkdownPlugin[] = [
  alertRemark,
  blockquoteAlertSchema,
  alertInputRule,
  alertKeymap,
].flat();
