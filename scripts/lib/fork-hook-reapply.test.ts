// Pure fixtures: the re-apply stage decides from text alone, so every anchor rule is exercised
// without a lane. The temp-repo fixture with a real conflicted index lives in
// `scripts/fork-sync-outcomes.test.ts`.

import { assert, it } from "@effect/vitest";

import { matchingDelimiter } from "./fork-conflict-outcomes.ts";
import { reapplyForkHooks } from "./fork-hook-reapply.ts";

const reapply = (merged: string, fork: string, entries: Parameters<typeof reapplyForkHooks>[2]) =>
  reapplyForkHooks(merged, fork, entries, matchingDelimiter);

it("treats a marker that survived the upstream rewrite as intact", () => {
  const merged =
    'import { a } from "a";\nimport { forkThing } from "fork"; // fork-hook: dom/name\nconst x = a();\n';
  const fork = 'import { forkThing } from "fork"; // fork-hook: dom/name\n';
  const result = reapply(merged, fork, [{ key: "dom/name", anchor: { kind: "import-block" } }]);
  assert.strictEqual(result.results[0]?.outcome.status, "intact");
  assert.strictEqual(result.reinserted.length, 0);
  assert.strictEqual(result.text, merged);
});

it("reads the import block past a comment header or directive preamble", () => {
  const merged = '// licence header\n"use client";\nimport { a } from "a";\nconst x = a();\n';
  const fork = 'import { forkThing } from "fork"; // fork-hook: dom/name\n';
  const result = reapply(merged, fork, [{ key: "dom/name", anchor: { kind: "import-block" } }]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  const lines = result.text.split("\n");
  assert.strictEqual(lines.indexOf('import { forkThing } from "fork"; // fork-hook: dom/name'), 3);
});

it("re-inserts a line hook after its single call site, marker exactly once", () => {
  const merged = "const session = startSession(opts);\nconst done = finish(session);\n";
  const fork = "const env = makeForkEnv(); // fork-hook: dom/env\n";
  const result = reapply(merged, fork, [
    { key: "dom/env", anchor: { kind: "after-call", symbol: "startSession" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  assert.deepStrictEqual(result.reinserted, ["dom/env"]);
  const lines = result.text.split("\n");
  assert.strictEqual(lines.indexOf("const env = makeForkEnv(); // fork-hook: dom/env"), 1);
  assert.strictEqual(
    result.text.split("fork-hook: dom/env").length - 1,
    1,
    "marker appears exactly once",
  );
  // No upstream line was touched by the insertion.
  assert.deepStrictEqual(
    lines.filter(
      (line) => line !== "" && line !== "const env = makeForkEnv(); // fork-hook: dom/env",
    ),
    merged.split("\n").filter((line) => line !== ""),
  );
});

it("re-inserts a hook inside a collection, before the closing brace", () => {
  const merged = "export interface Options {\n  name: string;\n}\n";
  const fork = "  forkThing: string; // fork-hook: dom/opt\n";
  const result = reapply(merged, fork, [
    { key: "dom/opt", anchor: { kind: "collection", symbol: "Options" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  assert.include(result.text, "  forkThing: string; // fork-hook: dom/opt\n}\n");
});

it("re-inserts a JSX pair inside its parent, end marker placed with it", () => {
  const merged = [
    "export function Panel() {",
    "  return (",
    "    <MenuPopup>",
    "      <Item />",
    "    </MenuPopup>",
    "  );",
    "}",
    "",
  ].join("\n");
  const fork = [
    "      {/* fork-hook: dom/badge */}",
    "      <Badge />",
    "      {/* fork-hook-end */}",
  ].join("\n");
  const result = reapply(merged, fork, [
    { key: "dom/badge", anchor: { kind: "jsx-parent", symbol: "MenuPopup" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  assert.strictEqual(result.text.split("fork-hook: dom/badge").length - 1, 1);
  assert.strictEqual(result.text.split("fork-hook-end").length - 1, 1);
  // The pair sits inside the parent: after the last child, before the closing tag's own line.
  const inserted = result.text.split("\n");
  assert.strictEqual(inserted.indexOf("      <Badge />"), inserted.indexOf("    </MenuPopup>") - 2);
  assert.strictEqual(
    inserted[inserted.indexOf("    </MenuPopup>") - 1],
    "      {/* fork-hook-end */}",
  );
});

it("refuses an ambiguous anchor by hook key", () => {
  const merged = "startSession(a);\nstartSession(b);\n";
  const fork = "const env = makeForkEnv(); // fork-hook: dom/env\n";
  const result = reapply(merged, fork, [
    { key: "dom/env", anchor: { kind: "after-call", symbol: "startSession" } },
  ]);
  assert.deepInclude(result.results[0], {
    key: "dom/env",
    outcome: {
      status: "refuse",
      reason: "`startSession` is called 2 times; the anchor is ambiguous",
    },
  });
  assert.strictEqual(result.reinserted.length, 0);
  assert.strictEqual(result.text, merged);
});

it("refuses a zero-site anchor instead of falling back to the file end", () => {
  const merged = "const x = other();\n";
  const fork = "const env = makeForkEnv(); // fork-hook: dom/env\n";
  const result = reapply(merged, fork, [
    { key: "dom/env", anchor: { kind: "after-call", symbol: "startSession" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "refuse" });
  assert.include(
    result.results[0]?.outcome.status === "refuse" ? result.results[0]?.outcome.reason : "",
    "no call site",
  );
});

it("refuses a hook whose marker is unreadable in the fork text", () => {
  const merged = 'import { a } from "a";\n';
  const result = reapply(merged, 'import { forkThing } from "fork";\n', [
    { key: "dom/name", anchor: { kind: "import-block" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, {
    status: "refuse",
    reason: "the fork side of this conflict carries no readable marker for the hook",
  });
});

it("refuses a JSX pair whose closing tag shares its line", () => {
  const merged =
    "export function Panel() {\n  return (\n    <MenuPopup>\n      <Item />\n    </MenuPopup>);\n}\n";
  const fork = "  {/* fork-hook: dom/badge */}\n  <Badge />\n  {/* fork-hook-end */}\n";
  const result = reapply(merged, fork, [
    { key: "dom/badge", anchor: { kind: "jsx-parent", symbol: "MenuPopup" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "refuse" });
  assert.include(
    result.results[0]?.outcome.status === "refuse" ? result.results[0]?.outcome.reason : "",
    "end marker cannot be placed",
  );
});

it("refuses a declaration anchor that matches several sites", () => {
  const merged = "const stamp = 1;\nconst stamp = 2;\n";
  const fork = "export { stamp }; // fork-hook: dom/stamp\n";
  const result = reapply(merged, fork, [
    { key: "dom/stamp", anchor: { kind: "after-decl", symbol: "stamp" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "refuse" });
  assert.include(
    result.results[0]?.outcome.status === "refuse" ? result.results[0]?.outcome.reason : "",
    "ambiguous",
  );
});

it("applies several reinsertions at one anchor in the order given", () => {
  const merged = 'import { a } from "a";\nconst x = a();\n';
  const forkA = 'import { forkOne } from "one"; // fork-hook: dom/one\n';
  const forkB = 'import { forkTwo } from "two"; // fork-hook: dom/two\n';
  const result = reapply(merged, `${forkA}${forkB}`, [
    { key: "dom/one", anchor: { kind: "import-block" } },
    { key: "dom/two", anchor: { kind: "import-block" } },
  ]);
  assert.deepStrictEqual(result.reinserted, ["dom/one", "dom/two"]);
  const lines = result.text.split("\n");
  assert.strictEqual(lines.indexOf('import { forkOne } from "one"; // fork-hook: dom/one'), 1);
  assert.strictEqual(lines.indexOf('import { forkTwo } from "two"; // fork-hook: dom/two'), 2);
});

it("re-inserts a multi-line import whole, marker on its last line", () => {
  const merged = 'import { a } from "a";\nconst x = a();\n';
  const fork = [
    "import {",
    "  forkThing,",
    '} from "./fork.fork.ts"; // fork-hook: dom/name',
    "",
  ].join("\n");
  const result = reapply(merged, fork, [{ key: "dom/name", anchor: { kind: "import-block" } }]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  const lines = result.text.split("\n");
  const at = lines.indexOf("import {");
  assert.notStrictEqual(at, -1);
  assert.strictEqual(lines[at + 1], "  forkThing,");
  assert.strictEqual(lines[at + 2], '} from "./fork.fork.ts"; // fork-hook: dom/name');
});

it("re-inserts a multi-line branch statement whole, marker on its closing brace", () => {
  const merged = "export function go() {\n  run();\n}\n";
  const fork = ["if (maybeFork()) {", "  forkDispatch();", "} // fork-hook: dom/branch", ""].join(
    "\n",
  );
  const result = reapply(merged, fork, [
    { key: "dom/branch", anchor: { kind: "after-call", symbol: "run" } },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  const lines = result.text.split("\n");
  const at = lines.findIndex((line) => line.trim() === "if (maybeFork()) {");
  assert.notStrictEqual(at, -1);
  assert.strictEqual(lines[at + 1]?.trim(), "forkDispatch();");
  assert.strictEqual(lines[at + 2]?.trim(), "} // fork-hook: dom/branch");
});

it("refuses a marker whose statement start cannot be proven", () => {
  const merged = 'import { a } from "a";\n';
  const fork = [
    "const stray = f(",
    '  "unterminated',
    '} from "./fork.fork.ts"; // fork-hook: dom/name',
    "",
  ].join("\n");
  const result = reapply(merged, fork, [{ key: "dom/name", anchor: { kind: "import-block" } }]);
  assert.deepInclude(result.results[0]?.outcome, {
    status: "refuse",
    reason: "the fork side of this conflict carries no readable marker for the hook",
  });
});

// RSI-Software/t3code-hyprws#1030: a span resolved from the fork tip's marker points at raw
// lines of the replayed fork text, which carry no marker at that commit. Re-insertion reads
// those raw lines — never an annotated copy — and an in-file marker keeps precedence.

it("re-inserts an overlaid tip span as the raw unmarked fork lines", () => {
  const merged = 'import { a } from "a";\nconst x = a();\n';
  const fork = 'import { forkThing } from "fork";\n';
  const span = {
    key: "dom/name",
    domain: "dom",
    name: "name",
    kind: "line" as const,
    startLine: 1,
    endLine: 1,
    overlay: true,
  };
  const result = reapplyForkHooks(
    merged,
    fork,
    [{ key: "dom/name", anchor: { kind: "import-block" } }],
    matchingDelimiter,
    { spans: new Map([["dom/name", span]]) },
  );
  assert.deepStrictEqual(result.reinserted, ["dom/name"]);
  assert.include(result.text, 'import { forkThing } from "fork";');
  assert.isFalse(result.text.includes("fork-hook"), "the overlay marker reached the output");
});

it("an in-file marker wins over an overlaid tip span for the same key", () => {
  const merged = 'import { a } from "a";\nconst x = a();\n';
  const fork = 'import { forkThing } from "fork"; // fork-hook: dom/name\nconst other = 1;\n';
  const span = {
    key: "dom/name",
    domain: "dom",
    name: "name",
    kind: "line" as const,
    startLine: 2,
    endLine: 2,
    overlay: true,
  };
  const result = reapplyForkHooks(
    merged,
    fork,
    [{ key: "dom/name", anchor: { kind: "import-block" } }],
    matchingDelimiter,
    { spans: new Map([["dom/name", span]]) },
  );
  assert.deepStrictEqual(result.reinserted, ["dom/name"]);
  // The marked line was read, not the overlay span's line 2.
  assert.include(result.text, 'import { forkThing } from "fork"; // fork-hook: dom/name');
  assert.isFalse(result.text.includes("const other"));
});
