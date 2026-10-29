import type { MilkdownPlugin } from "@milkdown/ctx";
import { InputRule, textblockTypeInputRule } from "@milkdown/prose/inputrules";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { NodeSelection, Plugin, TextSelection } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { $inputRule, $nodeSchema, $prose, $remark, $view } from "@milkdown/utils";
import remarkMath from "remark-math";
import type { Processor } from "unified";

// remark-math escapes every `$` in text, which would rewrite prices on each save.
function remarkFileMath(this: Processor) {
  remarkMath.call(this, { singleDollarTextMath: true });
  const extension = this.data().toMarkdownExtensions?.at(-1);
  if (extension?.unsafe) {
    extension.unsafe = extension.unsafe.filter(
      (pattern) => !(pattern.character === "$" && pattern.inConstruct === "phrasing"),
    );
  }
}

const mathRemark = $remark("remarkFileMath", () => remarkFileMath);

const mathInlineSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  content: "text*",
  marks: "",
  code: true,
  parseDOM: [{ tag: "span[data-type=math_inline]" }],
  toDOM: () => ["span", { "data-type": "math_inline" }, 0] as const,
  parseMarkdown: {
    match: ({ type }) => type === "inlineMath",
    runner: (state, node, type) => {
      state.openNode(type);
      if (typeof node["value"] === "string" && node["value"]) state.addText(node["value"]);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_inline",
    runner: (state, node) => {
      state.addNode("inlineMath", undefined, node.textContent);
    },
  },
}));

const mathBlockSchema = $nodeSchema("math_block", () => ({
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  attrs: { meta: { default: "", validate: "string" } },
  parseDOM: [{ tag: "div[data-type=math_block]", preserveWhitespace: "full" as const }],
  toDOM: () => ["div", { "data-type": "math_block" }, ["pre", {}, ["code", {}, 0]]] as const,
  parseMarkdown: {
    match: ({ type }) => type === "math",
    runner: (state, node, type) => {
      state.openNode(type, { meta: node["meta"] ?? "" });
      if (typeof node["value"] === "string" && node["value"]) state.addText(node["value"]);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_block",
    runner: (state, node) => {
      state.addNode("math", undefined, node.textContent, { meta: node.attrs["meta"] || null });
    },
  },
}));

const mathInlineInputRule = $inputRule(
  (ctx) =>
    new InputRule(/(?:^|[^$\\])\$([^\s$](?:[^$]*[^\s$])?)\$$/, (state, match, start, end) => {
      const tex = match[1] ?? "";
      const from = start + match[0].length - tex.length - 2;
      const type = mathInlineSchema.type(ctx);
      return state.tr.replaceWith(from, end, type.create(null, state.schema.text(tex)));
    }),
);

const mathBlockInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^\$\$\s$/, mathBlockSchema.type(ctx)),
);

/** GitHub math (`$…$`, `$$…$$`) as editable nodes, so saving keeps the TeX byte for byte. */
export const markdownMath: MilkdownPlugin[] = [
  mathRemark,
  mathInlineSchema,
  mathBlockSchema,
  mathInlineInputRule,
  mathBlockInputRule,
].flat();

let typesetModule: Promise<typeof import("~/components/chat/MathTypeset")> | null = null;

function mathView(schema: typeof mathInlineSchema | typeof mathBlockSchema, display: boolean) {
  return $view(schema.node, () => (initialNode, editorView, getPos) => {
    let node: ProseNode = initialNode;
    let tex: string | null = null;
    const dom = document.createElement(display ? "div" : "span");
    dom.className = `t3-markdown-editor__math t3-markdown-editor__math--${display ? "block" : "inline"}`;
    const source = document.createElement(display ? "pre" : "code");
    source.className = "t3-markdown-editor__math-source";
    const rendered = document.createElement(display ? "div" : "span");
    rendered.className = "t3-markdown-editor__math-rendered";
    rendered.contentEditable = "false";
    dom.append(source, rendered);

    const render = () => {
      const next = node.textContent.trim();
      if (next === tex) return;
      tex = next;
      typesetModule ??= import("~/components/chat/MathTypeset");
      void typesetModule.then(({ typeset }) => {
        if (tex !== next) return;
        const html = next ? typeset(next, display) : "";
        // KaTeX escapes the TeX it renders, and `trust: false` keeps it from emitting links.
        if (html) rendered.innerHTML = html;
        else rendered.textContent = next || "Empty equation";
        rendered.classList.toggle("is-invalid", !html);
      });
    };
    render();

    // Clicking the formula moves the caret into its source, which the editing class reveals.
    rendered.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const position = getPos();
      if (typeof position !== "number") return;
      const end = position + 1 + node.content.size;
      editorView.dispatch(
        editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, end)),
      );
      editorView.focus();
    });

    return {
      dom,
      contentDOM: source,
      update(nextNode) {
        if (nextNode.type !== node.type) return false;
        node = nextNode;
        render();
        return true;
      },
      stopEvent: (event) => event.target instanceof Node && rendered.contains(event.target),
      ignoreMutation: (mutation) => rendered.contains(mutation.target),
    };
  });
}

// Shows a formula's or diagram's source while the selection is inside it, and the render otherwise.
const mathEditing = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const { selection } = state;
          const selected = selection instanceof NodeSelection ? selection.node : null;
          const node = selected ?? selection.$from.parent;
          const rendered =
            node.type.name.startsWith("math_") ||
            (node.type.name === "code_block" && node.attrs["language"] === "mermaid");
          if (!rendered) return null;
          const position = selected ? selection.from : selection.$from.before();
          return DecorationSet.create(state.doc, [
            Decoration.node(position, position + node.nodeSize, { class: "is-editing" }),
          ]);
        },
      },
    }),
);

export function markdownMathViews(): MilkdownPlugin[] {
  return [mathView(mathInlineSchema, false), mathView(mathBlockSchema, true), mathEditing];
}
