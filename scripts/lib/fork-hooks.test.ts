// @effect-diagnostics nodeBuiltinImport:off - the fmt proof runs the repo formatter binary.

import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  deriveForkHooks,
  deriveForkHooksIn,
  forkHookConstructViolation,
  ForkHookDeclarationError,
  FORK_HOOK_JSX_END,
  FORK_HOOK_JSX_OPEN,
  FORK_HOOK_LINE_MARKER,
  FORK_HOOK_LINE_SUFFIX,
  FORK_HOOK_BLOCK_SUFFIX,
  forkHookKey,
  isWellFormedForkHookKey,
  parseForkHookMarkers,
  statementStartLine,
  stripForkHookLineMarker,
} from "./fork-hooks.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

it("derives a hook's anchor from the shortest unique run of unmarked lines before it", () => {
  const content = [
    'import { a } from "a";',
    'import { forkThing } from "./fork.fork.ts"; // fork-hook: fork-meta/fork-thing',
    "",
    "export const go = () => {",
    "  run();",
    "  forkRun(); // fork-hook: fork-meta/fork-run",
    "};",
    "",
  ].join("\n");
  const hooks = deriveForkHooksIn("apps/web/src/go.ts", content);
  assert.deepStrictEqual(
    hooks.map((hook) => ({ key: hook.key, path: hook.path, context: hook.anchor.context })),
    [
      {
        key: "fork-meta/fork-thing",
        path: "apps/web/src/go.ts",
        context: ['import { a } from "a";'],
      },
      { key: "fork-meta/fork-run", path: "apps/web/src/go.ts", context: ["  run();"] },
    ],
  );
  // The span is the marked line itself, so the anchor's context never carries a marker.
  assert.deepStrictEqual(
    hooks.map((hook) => [hook.span.startLine, hook.span.endLine]),
    [
      [2, 2],
      [6, 6],
    ],
  );
});

it("grows the context until it is unique, and takes the file top when there is none", () => {
  const content = [
    "const head = 1;",
    "run();",
    "forkOne(); // fork-hook: fork-meta/one",
    "tail();",
    "run();",
    "",
  ].join("\n");
  const [hook] = deriveForkHooksIn("apps/web/src/dup.ts", content);
  // `run();` alone occurs twice in the unmarked text, so the anchor grows to the pair above it.
  assert.deepStrictEqual(hook?.anchor.context, ["const head = 1;", "run();"]);
  assert.deepStrictEqual(
    deriveForkHooksIn(
      "apps/web/src/top.ts",
      'import { f } from "f"; // fork-hook: fork-meta/top\n',
    )[0]?.anchor.context,
    [],
  );
});

it("orders the manifest by file path, then by marker order in the file", () => {
  const hooks = deriveForkHooks(
    new Map([
      ["apps/web/b.ts", "const b = 1;\nforkB(); // fork-hook: fork-meta/b\n"],
      [
        "apps/web/a.ts",
        "const a = 1;\nforkA(); // fork-hook: fork-meta/a\nforkC(); // fork-hook: fork-meta/c\n",
      ],
    ]),
  );
  assert.deepStrictEqual(
    hooks.map((hook) => hook.key),
    ["fork-meta/a", "fork-meta/c", "fork-meta/b"],
  );
});

it("refuses an unmatched JSX marker pair with path:line", () => {
  assert.throws(
    () =>
      deriveForkHooksIn(
        "apps/web/src/Panel.tsx",
        ["<div>", "  {/* fork-hook: fork-meta/badge */}", "  <Badge />", "</div>", ""].join("\n"),
      ),
    ForkHookDeclarationError,
    /^apps\/web\/src\/Panel\.tsx:2: unmatched fork-hook JSX marker/,
  );
  assert.throws(
    () => deriveForkHooksIn("apps/web/src/Panel.tsx", "<div>\n  {/* fork-hook-end */}\n</div>\n"),
    ForkHookDeclarationError,
    /^apps\/web\/src\/Panel\.tsx:2: unmatched fork-hook JSX marker/,
  );
});

it("refuses an unknown domain with path:line", () => {
  assert.throws(
    () =>
      deriveForkHooksIn("apps/web/src/go.ts", "const a = 1;\nforkGo(); // fork-hook: nope/go\n"),
    ForkHookDeclarationError,
    /^apps\/web\/src\/go\.ts:2: unknown fork domain `nope`/,
  );
});

it("holds the one-construct doctrine on the classifying line", () => {
  for (const code of [
    'import { f } from "./f.fork.ts";',
    '@import "./index.fork.css";',
    "registerForkPolicy(input);",
    "const policy = resolveForkPolicy(input);",
    "export { forkThing };",
    "...forkProps,",
    "forkPolicy: resolveForkPolicy,",
  ])
    assert.isFalse(forkHookConstructViolation(code, false), `${code} is one construct`);
  assert.isFalse(forkHookConstructViolation("if (isFork(x)) {", true), "a marked block is one");
  assert.isTrue(forkHookConstructViolation("if (isFork(x)) run();", false), "a one-line branch");
  assert.isTrue(forkHookConstructViolation("const a = 1, b = 2;", false), "two declarations");
  assert.isTrue(forkHookConstructViolation("name: upstreamThing,", false), "no fork identifier");
});

it("rejects malformed keys", () => {
  for (const key of ["no-slash", "unknown-domain/name", "/name", "name/", "fork-meta/"])
    assert.isFalse(isWellFormedForkHookKey(key), `${key} must be rejected`);
});

it("parses a trailing line marker and strips it without touching the code", () => {
  const line =
    'import { spawnTarget } from "./spawnTarget.fork.ts"; // fork-hook: project-windows/spawn-target';
  const hooks = parseForkHookMarkers(`const stale = 1;\n${line}\nb`);
  assert.strictEqual(hooks.length, 1);
  assert.deepInclude(hooks[0], {
    key: "project-windows/spawn-target",
    kind: "line",
    startLine: 2,
    endLine: 2,
  });
  assert.strictEqual(
    stripForkHookLineMarker(line),
    'import { spawnTarget } from "./spawnTarget.fork.ts";',
  );
  assert.match(line, FORK_HOOK_LINE_SUFFIX);
  assert.strictEqual(FORK_HOOK_LINE_MARKER.test(line.trim()), false);
  assert.strictEqual(
    FORK_HOOK_LINE_MARKER.test("// fork-hook: project-windows/spawn-target"),
    true,
  );
});

it("parses a trailing block-comment marker (CSS) and bounds it to its line", () => {
  const line = '@import "./index.fork.css"; /* fork-hook: project-windows/index-fork-css */';
  const hooks = parseForkHookMarkers(`@import "tailwindcss";\n${line}\n.wco {}`);
  assert.strictEqual(hooks.length, 1);
  assert.deepInclude(hooks[0], {
    key: "project-windows/index-fork-css",
    kind: "line",
    startLine: 2,
    endLine: 2,
  });
  assert.match(line, FORK_HOOK_BLOCK_SUFFIX);
  assert.strictEqual(FORK_HOOK_BLOCK_SUFFIX.test("/* fork-hook: fork-meta/a */ .x {}"), false);
});

it("does not mark a mid-line or non-trailing comment", () => {
  assert.strictEqual(
    parseForkHookMarkers("const x = 1; /* fork-hook: fork-meta/a */ // trailing\n").length,
    0,
  );
  assert.strictEqual(parseForkHookMarkers("// fork-hook: fork-meta/a but more words\n").length, 0);
});

it("parses a JSX pair and bounds the region inclusively", () => {
  const content = [
    "<div>",
    "  {/* fork-hook: project-windows/preview-pane */}",
    "  <PreviewPane />",
    "  {/* fork-hook-end */}",
    "</div>",
  ].join("\n");
  const hooks = parseForkHookMarkers(content);
  assert.strictEqual(hooks.length, 1);
  assert.deepInclude(hooks[0], {
    key: "project-windows/preview-pane",
    kind: "jsx",
    startLine: 2,
    endLine: 4,
  });
});

it("bounds an unclosed JSX marker at end of file instead of leaking unmarked lines", () => {
  const hooks = parseForkHookMarkers("{/* fork-hook: fork-meta/x */}\n<Widget />\n");
  assert.strictEqual(hooks.length, 1);
  assert.strictEqual(hooks[0]?.endLine, 3);
});

it("collects every marker form through the shared regexes", () => {
  assert.match("<div>{/* fork-hook: fork-meta/x */}", FORK_HOOK_JSX_OPEN);
  assert.match("{/* fork-hook-end */}", FORK_HOOK_JSX_END);
  assert.strictEqual(forkHookKey("fork-meta", "x"), "fork-meta/x");
});

it("walks a line marker back to the whole multi-line statement it closes", () => {
  const multilineImport = [
    'import { a } from "a";',
    "import {",
    "  forkThing,",
    '} from "./fork.fork.ts"; // fork-hook: dom/name',
  ].join("\n");
  const hooks = parseForkHookMarkers(multilineImport);
  assert.strictEqual(hooks.length, 1);
  assert.deepInclude(hooks[0], { key: "dom/name", kind: "line", startLine: 2, endLine: 4 });
  assert.strictEqual(statementStartLine(multilineImport.split("\n"), 4), 2);
  // Line 3 is inside the import's braces, so its own statement scope starts there: the walk is
  // judged against the nesting the queried line leaves, never the file's top level.
  assert.strictEqual(statementStartLine(multilineImport.split("\n"), 3), 3);
});

it("bounds a branch statement and template literals behind a trailing marker", () => {
  const branch = [
    "const ready = true;",
    "if (maybeFork()) {",
    "  doThing(`tick ${name} tock`);",
    "} // fork-hook: dom/branch",
  ].join("\n");
  assert.strictEqual(statementStartLine(branch.split("\n"), 4), 2);
  const template = [
    "const first = 1;",
    "const t = `run ${name",
    "  } tail`; // fork-hook: dom/x",
  ].join("\n");
  assert.strictEqual(statementStartLine(template.split("\n"), 3), 2);
  // A single-line statement after a closed one stays its own line.
  const singleLines = ["const a = 1;", "markIt(); // x"].join("\n").split("\n");
  const got = statementStartLine(singleLines, 2);
  assert.strictEqual(got, 2, JSON.stringify({ singleLines, got }));
});

it("refuses a statement start it cannot prove", () => {
  const lines = (text: string) => text.split("\n");
  // Marker inside a string.
  assert.strictEqual(
    statementStartLine(lines('const s = "open\n// fork-hook: dom/x\nrest";'), 2),
    null,
  );
  // A stray close makes the pre-image unbalanced.
  assert.strictEqual(statementStartLine(lines("const a = b;\n};\n} // fork-hook: dom/x"), 3), null);
  // An unclosed template literal.
  assert.strictEqual(statementStartLine(lines("const t = `run\n// fork-hook: dom/x\n`;"), 2), null);
});

it("keeps a single-line line marker bounded to its own line", () => {
  const content = [
    "const base = 1;",
    'import { forkThing } from "fork"; // fork-hook: dom/name',
  ].join("\n");
  const hooks = parseForkHookMarkers(content);
  assert.strictEqual(hooks.length, 1);
  assert.deepInclude(hooks[0], { key: "dom/name", startLine: 2, endLine: 2 });
});

// The repo's formatter is `vp fmt`, which forwards to the repo's Oxfmt binary
// (`node_modules/.bin/oxfmt`); prettier exists only as a transitive dependency
// and no prettier config ships. The proof runs that binary directly — the same
// formatter `vp fmt` applies — so a marker surviving it is what lands.
it("keeps a trailing fork-hook marker on its line through the repo formatter", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const oxfmt = NodePath.join(repoRoot, "node_modules/.bin/oxfmt");
  // oxfmt's stdin mode stalls when driven through a spawned pipe, so the
  // snippet is written to a temp file and redirected in.
  const fmt = async (filepath: string, snippet: string): Promise<string> => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-hook-fmt-"));
    try {
      const file = NodePath.join(dir, filepath);
      NodeFS.writeFileSync(file, snippet);
      const { stdout } = await run("sh", [
        "-c",
        `"${oxfmt}" --stdin-filepath="${filepath}" < "${file}"`,
      ]);
      return stdout;
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const [filepath, snippet] of [
    [
      "hook.ts",
      'import { spawnTarget } from "./spawnTarget.fork.ts"; // fork-hook: project-windows/spawn-target\nexport const one = 1;\n',
    ],
    [
      "hook.ts",
      "registerWindowPolicy(resolveWindowPolicy(input)); // fork-hook: project-windows/register-policy\nexport const two = 2;\n",
    ],
    [
      "hook.ts",
      "const policy = resolveWindowPolicy(input); // fork-hook: project-windows/window-policy\nexport const three = 3;\n",
    ],
    [
      "hook.tsx",
      "const row = <Row policy={windowPolicy} />; // fork-hook: project-windows/window-policy-row\nexport const four = 4;\n",
    ],
    [
      "hook.tsx",
      "export const five = { windowPolicy: resolveWindowPolicy(input) }; // fork-hook: project-windows/window-policy-prop\n",
    ],
  ] as const) {
    const formatted = await fmt(filepath, snippet);
    for (const line of formatted.split("\n"))
      if (line.includes("fork-hook:"))
        assert.match(
          line,
          /fork-hook: [\w-]+\/[\w-]+ \*\/$|fork-hook: [\w-]+\/[\w-]+$/,
          `marker must end its line in:\n${formatted}`,
        );
    assert.include(formatted, "fork-hook:");
  }
  // The JSX pair survives formatting with both markers intact.
  const jsx = await fmt(
    "hook.tsx",
    [
      "export const View = () => (",
      "  <div>",
      "    {/* fork-hook: project-windows/preview-pane */}",
      "    <PreviewPane />",
      "    {/* fork-hook-end */}",
      "  </div>",
      ");",
      "",
    ].join("\n"),
  );
  assert.include(jsx, "{/* fork-hook: project-windows/preview-pane */}");
  assert.include(jsx, "{/* fork-hook-end */}");
  const open = jsx.split("\n").findIndex((line) => line.includes("fork-hook:"));
  const close = jsx.split("\n").findIndex((line) => line.includes("fork-hook-end"));
  assert.isTrue(close > open + 1, `pair must wrap a construct:\n${jsx}`);
});
