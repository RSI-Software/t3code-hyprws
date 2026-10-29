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
