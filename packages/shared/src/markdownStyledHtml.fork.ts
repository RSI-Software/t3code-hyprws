import type { PluggableList } from "unified";
import rehypeSanitize, { type Options as SanitizeSchema } from "rehype-sanitize";

// `@scope` limits selectors only; `@keyframes`, `@font-face`, `@property` and similar define
// document-global names, so only selector rules and the conditions around them survive.
const SCOPED_RULE_TYPES = [
  "CSSStyleRule",
  "CSSNestedDeclarations",
  "CSSMediaRule",
  "CSSSupportsRule",
  "CSSContainerRule",
  "CSSLayerBlockRule",
  "CSSScopeRule",
  "CSSStartingStyleRule",
];

function isScopedRule(rule: CSSRule): boolean {
  return SCOPED_RULE_TYPES.some((name) => {
    const type = (globalThis as Record<string, unknown>)[name];
    return typeof type === "function" && rule instanceof type;
  });
}

function keepScopedRules(owner: CSSStyleSheet | CSSGroupingRule) {
  for (let index = owner.cssRules.length - 1; index >= 0; index--) {
    const rule = owner.cssRules[index]!;
    if (!isScopedRule(rule)) owner.deleteRule(index);
    else if (rule instanceof CSSGroupingRule) keepScopedRules(rule);
  }
}

/**
 * Wraps document CSS in `@scope` so a Markdown file's `<style>` cannot restyle the app. Rules are
 * re-serialized through CSSOM first, so an unbalanced `}` cannot close the scope early. Without a
 * `root`, the scope is the `<style>` element's parent.
 */
export function scopeMarkdownCss(css: string, root?: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  keepScopedRules(sheet);
  const rules = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
  return `@scope${root ? ` (${root})` : ""} {\n${rules}\n}`;
}

const STYLED_HTML_TAGS = [
  "style",
  "small",
  "u",
  "mark",
  "abbr",
  "center",
  "figure",
  "figcaption",
  "caption",
  "colgroup",
  "col",
  "header",
  "footer",
  "nav",
  "article",
  "aside",
  "main",
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "text",
  "tspan",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "use",
  "symbol",
  "clipPath",
];

const STYLED_HTML_ATTRIBUTES = [
  "className",
  "style",
  "viewBox",
  "preserveAspectRatio",
  "xmlns",
  "d",
  "fill",
  "fillRule",
  "fillOpacity",
  "clipRule",
  "clipPath",
  "stroke",
  "strokeWidth",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeOpacity",
  "opacity",
  "transform",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "offset",
  "stopColor",
  "gradientUnits",
  "textAnchor",
  "fontSize",
  "fontWeight",
  "href",
];

function styledHtmlSchema(base: SanitizeSchema): SanitizeSchema {
  return {
    ...base,
    tagNames: [...(base.tagNames ?? []), ...STYLED_HTML_TAGS],
    attributes: {
      ...base.attributes,
      "*": [...(base.attributes?.["*"] ?? []), ...STYLED_HTML_ATTRIBUTES],
    },
    // Document CSS selects by authored ids, so they stay unprefixed.
    clobber: (base.clobber ?? []).filter((property) => property !== "id"),
  };
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * Hoists every `<style>` into an inner wrapper, its `@scope` root, inside an outer one that
 * `contain: paint`s the document. Scoped rules cannot select the outer wrapper, so neither the
 * scope root nor fixed-position content can cover the app.
 */
function rehypeScopeStyles() {
  return (tree: HastNode) => {
    const styles: HastNode[] = [];
    let styled = false;
    const visit = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.filter((child) => {
        if (child.type !== "element") return true;
        if (child.tagName === "style") {
          const css = (child.children ?? []).map((text) => text.value ?? "").join("");
          styles.push({ ...child, children: [{ type: "text", value: scopeMarkdownCss(css) }] });
          return false;
        }
        if (child.properties?.["style"] !== undefined) styled = true;
        visit(child);
        return true;
      });
    };
    visit(tree);
    if (!styled && styles.length === 0) return;
    const inner = {
      type: "element",
      tagName: "div",
      properties: {},
      children: [...styles, ...(tree.children ?? [])],
    };
    tree.children = [
      {
        type: "element",
        tagName: "div",
        properties: { style: "contain: paint" },
        children: [inner],
      },
    ];
  };
}

/**
 * Turns the chat rehype pipeline into one for whole Markdown files: it also keeps classes,
 * inline styles, SVG, and scoped `<style>`. Scripts and event handlers are still stripped.
 */
export function withStyledHtml(plugins: PluggableList): PluggableList {
  return plugins.flatMap((plugin) =>
    Array.isArray(plugin) && plugin[0] === rehypeSanitize
      ? [[rehypeSanitize, styledHtmlSchema(plugin[1] as SanitizeSchema)], rehypeScopeStyles]
      : [plugin],
  );
}
