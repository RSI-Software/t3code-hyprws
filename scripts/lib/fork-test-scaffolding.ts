import ts from "typescript-legacy";

const importsIn = (text: string) => {
  const source = ts.createSourceFile("test.ts", text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      return [];
    const clause = statement.importClause;
    const names: string[] = [];
    if (clause?.name) names.push(`default:${clause.name.text}`);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.push(`*:${bindings.name.text}`);
    else if (bindings)
      for (const element of bindings.elements)
        names.push(`${element.propertyName?.text ?? element.name.text}:${element.name.text}`);
    const module = statement.moduleSpecifier.text;
    return [{ keys: names.map((name) => `${module}:${name}`), text: statement.getText(source) }];
  });
};

/** Only non-assertion scaffolding carried by the head or the declared replacement sibling. */
export function relocatedTestScaffolding(upstream: string, head: string, sibling: string) {
  const bindings = new Set([...importsIn(head), ...importsIn(sibling)].flatMap(({ keys }) => keys));
  const lines = new Set<string>();
  for (const entry of importsIn(upstream)) {
    if (entry.keys.length > 0 && entry.keys.every((key) => bindings.has(key))) {
      for (const line of entry.text.split("\n")) lines.add(line.trim());
    }
  }
  const siblingLines = new Set(sibling.split("\n").map((line) => line.trim()));
  const headLines = new Set(head.split("\n").map((line) => line.trim()));
  const movedSuites = upstream
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^describe\s*\(.+=>\s*\{$/.test(line) && siblingLines.has(line) && !headLines.has(line),
    );
  for (const line of movedSuites) lines.add(line);
  return { lines, suites: movedSuites.length };
}
