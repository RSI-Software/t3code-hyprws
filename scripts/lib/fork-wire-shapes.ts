export type WireShape =
  | {
      readonly kind: "literals";
      readonly name: string;
      readonly members: ReadonlySet<string>;
    }
  | {
      readonly kind: "struct";
      readonly name: string;
      readonly fields: ReadonlyMap<string, { readonly optional: boolean }>;
    };

export interface WireShapeFinding {
  readonly schema: string;
  readonly change: string;
  readonly hint: string;
}

export type ForkWireBaseline = ReadonlyMap<string, string>;

export const parseForkWireBaseline = (source: string): ForkWireBaseline => {
  const entries = new Map<string, string>();
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const header = lines.findIndex((line) => /^\|\s*Key\s*\|\s*Reason\s*\|\s*$/.test(line));
  if (header === -1) return entries;
  for (const line of lines.slice(header + 2)) {
    const match = /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (match === null) break;
    const key = match[1]?.replaceAll("\\|", "|").trim() ?? "";
    const reason = match[2]?.replaceAll("\\|", "|").trim() ?? "";
    if (key.length > 0) entries.set(key, reason);
  }
  return entries;
};

export const wireFindingKey = (subject: string, finding: WireShapeFinding): string =>
  finding.schema === "ipc.ts" && finding.change === "desktop IPC shape changed"
    ? `ipc.ts: desktop IPC shape changed: ${subject}`
    : `${finding.schema}: ${finding.change}`;

const REVIEW_HINT =
  "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>";

type ScanState = "code" | "single" | "double" | "template" | "line-comment" | "block-comment";

const matchingDelimiter = (source: string, openingIndex: number): number => {
  const opening = source[openingIndex];
  const closing = opening === "[" ? "]" : opening === "{" ? "}" : opening === "(" ? ")" : "";
  if (closing === "") return -1;

  let depth = 0;
  let state: ScanState = "code";
  for (let index = openingIndex; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state !== "code") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === quote) state = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single";
      continue;
    }
    if (char === '"') {
      state = "double";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const decodeStringLiteral = (literal: string): string => {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return body;
    }
  }
  return body.replace(/\\(['\\bfnrtv])/g, (_match, escaped: string) => {
    const simpleEscapes: Record<string, string> = {
      "'": "'",
      "\\": "\\",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    return simpleEscapes[escaped] ?? escaped;
  });
};

const stringLiterals = (source: string): ReadonlyArray<string> => {
  const values: Array<string> = [];
  let state: "code" | "line-comment" | "block-comment" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char !== "'" && char !== '"') continue;
    const quote = char;
    const start = index;
    for (index += 1; index < source.length; index += 1) {
      const inner = source[index] ?? "";
      if (inner === "\\") {
        index += 1;
        continue;
      }
      if (inner === quote) {
        values.push(decodeStringLiteral(source.slice(start, index + 1)));
        break;
      }
    }
  }
  return values;
};

const splitTopLevel = (source: string, separator = ","): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let state: ScanState = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state !== "code") {
      if (char === "\\") index += 1;
      else {
        const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
        if (char === quote) state = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "template";
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === separator && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
};

const topLevelColon = (source: string): number => {
  const [first = ""] = splitTopLevel(source, ":");
  if (first.length >= source.length) return -1;
  return first.length;
};

const parseStructFields = (body: string): ReadonlyMap<string, { readonly optional: boolean }> => {
  const fields = new Map<string, { readonly optional: boolean }>();
  for (const part of splitTopLevel(body)) {
    const colon = topLevelColon(part);
    if (colon === -1) continue;
    const rawKey = part
      .slice(0, colon)
      .replace(/^\s*(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*))*/, "")
      .trim();
    const value = part.slice(colon + 1).trim();
    const identifier = /^[A-Za-z_$][\w$]*$/.exec(rawKey)?.[0];
    const quoted = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(rawKey)
      ? decodeStringLiteral(rawKey)
      : undefined;
    const key = identifier ?? quoted;
    if (key === undefined) continue;
    fields.set(key, {
      optional:
        /\b(?:Schema\.(?:optional|optionalKey|optionalWith)|withDecodingDefault|withConstructorDefault)\b/.test(
          value,
        ),
    });
  }
  return fields;
};

export const extractWireShapes = (source: string): ReadonlyArray<WireShape> => {
  const shapes: Array<WireShape> = [];
  const binding = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (let match = binding.exec(source); match !== null; match = binding.exec(source)) {
    const name = match[1];
    if (name === undefined) continue;
    const tail = source.slice(binding.lastIndex);
    const call = /^\s*Schema\.(Literals|Struct)\s*\(\s*([\[{])/.exec(tail);
    if (call === null) continue;
    const kind = call[1];
    const opening = kind === "Literals" ? "[" : "{";
    if (call[2] !== opening) continue;
    const openingIndex = binding.lastIndex + call[0].lastIndexOf(opening);
    const closingIndex = matchingDelimiter(source, openingIndex);
    if (closingIndex === -1) continue;
    const body = source.slice(openingIndex + 1, closingIndex);
    if (kind === "Literals") {
      shapes.push({ kind: "literals", name, members: new Set(stringLiterals(body)) });
    } else {
      shapes.push({ kind: "struct", name, fields: parseStructFields(body) });
    }
  }
  return shapes;
};

type SemanticChange =
  | { readonly kind: "literal-added"; readonly schema: string; readonly value: string }
  | { readonly kind: "literal-removed"; readonly schema: string; readonly value: string }
  | { readonly kind: "required-field-added"; readonly schema: string; readonly key: string }
  | { readonly kind: "optional-field-added"; readonly schema: string; readonly key: string }
  | { readonly kind: "field-removed"; readonly schema: string; readonly key: string }
  | { readonly kind: "field-optionality-changed"; readonly schema: string; readonly key: string }
  | {
      readonly kind: "schema-added" | "schema-removed" | "schema-kind-changed";
      readonly schema: string;
    };

const semanticChanges = (
  before: ReadonlyArray<WireShape>,
  after: ReadonlyArray<WireShape>,
): ReadonlyArray<SemanticChange> => {
  const changes: Array<SemanticChange> = [];
  const beforeByName = new Map(before.map((shape) => [shape.name, shape]));
  const afterByName = new Map(after.map((shape) => [shape.name, shape]));
  for (const [name, beforeShape] of beforeByName) {
    const afterShape = afterByName.get(name);
    if (afterShape === undefined) {
      changes.push({ kind: "schema-removed", schema: name });
      continue;
    }
    if (beforeShape.kind !== afterShape.kind) {
      changes.push({ kind: "schema-kind-changed", schema: name });
      continue;
    }
    if (beforeShape.kind === "literals" && afterShape.kind === "literals") {
      for (const value of afterShape.members) {
        if (!beforeShape.members.has(value))
          changes.push({ kind: "literal-added", schema: name, value });
      }
      for (const value of beforeShape.members) {
        if (!afterShape.members.has(value))
          changes.push({ kind: "literal-removed", schema: name, value });
      }
      continue;
    }
    if (beforeShape.kind === "struct" && afterShape.kind === "struct") {
      const removed = [...beforeShape.fields.keys()].filter((key) => !afterShape.fields.has(key));
      if (removed.length > 0) {
        for (const key of removed) changes.push({ kind: "field-removed", schema: name, key });
        continue;
      }
      for (const [key, field] of afterShape.fields) {
        const previous = beforeShape.fields.get(key);
        if (previous === undefined) {
          changes.push({
            kind: field.optional ? "optional-field-added" : "required-field-added",
            schema: name,
            key,
          });
        } else if (previous.optional !== field.optional) {
          changes.push({ kind: "field-optionality-changed", schema: name, key });
        }
      }
    }
  }
  for (const name of afterByName.keys()) {
    if (!beforeByName.has(name)) changes.push({ kind: "schema-added", schema: name });
  }
  return changes;
};

export const compareWireShapes = (
  before: string,
  after: string,
  path: string,
): ReadonlyArray<WireShapeFinding> => {
  if (before === after) return [];
  const changes = semanticChanges(extractWireShapes(before), extractWireShapes(after));
  if (path === "packages/contracts/src/ipc.ts") {
    if (changes.length > 0 && changes.every((change) => change.kind === "optional-field-added")) {
      return [];
    }
    return [{ schema: "ipc.ts", change: "desktop IPC shape changed", hint: REVIEW_HINT }];
  }
  return changes.flatMap((change): ReadonlyArray<WireShapeFinding> => {
    switch (change.kind) {
      case "literal-added":
        return [
          { schema: change.schema, change: `literal added: ${change.value}`, hint: REVIEW_HINT },
        ];
      case "required-field-added":
        return [
          {
            schema: change.schema,
            change: `required field added: ${change.key}`,
            hint: REVIEW_HINT,
          },
        ];
      case "field-removed":
        return [
          { schema: change.schema, change: `field removed: ${change.key}`, hint: REVIEW_HINT },
        ];
      default:
        return [];
    }
  });
};
