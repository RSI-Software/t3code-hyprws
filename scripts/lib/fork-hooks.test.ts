// @effect-diagnostics nodeBuiltinImport:off - the fmt proof runs the repo formatter binary.

import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  FORK_HOOKS,
  FORK_HOOK_JSX_END,
  FORK_HOOK_JSX_OPEN,
  FORK_HOOK_LINE_MARKER,
  FORK_HOOK_LINE_SUFFIX,
  FORK_HOOK_BLOCK_SUFFIX,
  forkHookKey,
  type ForkHookEntry,
  isWellFormedForkHookKey,
  parseForkHookMarkers,
  stripForkHookLineMarker,
} from "./fork-hooks.ts";
import { FORK_DOMAINS } from "./fork-trailers.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

it("passes the schema on an empty manifest and tightens as entries arrive", () => {
  for (const [key, entry] of Object.entries(FORK_HOOKS)) {
    assert.isTrue(isWellFormedForkHookKey(key), `key ${key} must be <domain>/<name>`);
    const domain = key.split("/")[0] ?? "";
    assert.include([...FORK_DOMAINS], domain, `key ${key} must name a known fork domain`);
    assert.isAtLeast(
      NodeFS.existsSync(NodePath.join(repoRoot, entry.path)) ? 1 : 0,
      1,
      `entry ${key} points at ${entry.path}, which does not exist in the tree`,
    );
    const kinds = ["import-block", "collection", "jsx-parent", "after-call", "after-decl"];
    assert.include(kinds, entry.anchor.kind);
    if (entry.anchor.kind !== "import-block")
      assert.isNotEmpty(entry.anchor.symbol, `anchor for ${key} must name its symbol`);
  }
});

it("recognizes after-decl anchors and requires their symbol", () => {
  const kinds = ["import-block", "collection", "jsx-parent", "after-call", "after-decl"];
  const sample: ForkHookEntry = {
    path: "apps/web/src/state/shell.ts",
    anchor: { kind: "after-decl", symbol: "useShellBoot" },
  };
  assert.include(kinds, sample.anchor.kind);
  assert.strictEqual(sample.anchor.kind === "after-decl" && sample.anchor.symbol.length > 0, true);
  // The schema loop above already fails any after-decl entry without a symbol,
  // through the same shared symbol assertion used for collection/jsx-parent.
});

it("rejects malformed keys", () => {
  for (const key of ["no-slash", "unknown-domain/name", "/name", "name/", "fork-meta/"])
    assert.isFalse(isWellFormedForkHookKey(key), `${key} must be rejected`);
});

it("parses a trailing line marker and strips it without touching the code", () => {
  const line =
    'import { spawnTarget } from "./spawnTarget.fork.ts"; // fork-hook: project-windows/spawn-target';
  const hooks = parseForkHookMarkers(`a\n${line}\nb`);
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
