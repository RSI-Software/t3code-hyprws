// @effect-diagnostics nodeBuiltinImport:off - The rename follow-up commits in a real git repository.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { git, realRunner } from "./fork-sync-git.ts";
import {
  commitUpstreamContextRenames,
  contextPaths,
  followContextRenames,
} from "./fork-workflow-context.ts";

it("moves a missing context path to its rename, touching only the frontmatter's context node", () => {
  const renames = new Map([
    ["docs/web-ui.md", "docs/10_web-ui.md"],
    ["docs/kept.md", "docs/moved.md"],
  ]);
  const exists = (path: string) => path === "docs/kept.md";
  const rubric = "\nQuote `context: [docs/web-ui.md]` as an example.\n";
  const other = 'paths:\n  include: ["docs/web-ui.md"]\n';
  const after = `---\nname: UI\n${other}context: [docs/10_web-ui.md, docs/kept.md]\nneeds: [checkout]\n---${rubric}`;
  const flow = `---\nname: UI\n${other}context: [docs/web-ui.md, docs/kept.md]\nneeds: [checkout]\n---${rubric}`;
  const block = `---\nname: UI\n${other}context:\n  - "docs\\x2Fweb-ui.md"\n  - docs/kept.md\nneeds: [checkout]\n---${rubric}`;
  assert.deepStrictEqual(contextPaths(block), ["docs/web-ui.md", "docs/kept.md"]);
  assert.strictEqual(followContextRenames(flow, renames, exists), after);
  assert.strictEqual(followContextRenames(block, renames, exists), after);
  assert.deepStrictEqual(contextPaths(rubric), []);
  // A flow list over several lines is left for the scan to fail, never half-rewritten.
  const wrapped = `---\nname: UI\ncontext: [\n  docs/web-ui.md\n]\n---${rubric}`;
  assert.strictEqual(followContextRenames(wrapped, renames, exists), wrapped);
});

it("commits the context follow-up once, with the fork trailers", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-workflow-context-"));
  try {
    const run = (args: ReadonlyArray<string>) => git(realRunner, root, args);
    const write = (path: string, text: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, path), text);
      run(["add", path]);
    };
    run(["init", "--quiet"]);
    run(["config", "user.name", "test"]);
    run(["config", "user.email", "test@example.com"]);
    const workflow = ".rsi-agent/workflows/ui.md";
    write("docs/web-ui.md", "rules\n");
    write(workflow, "---\nname: UI\ncontext: [docs/web-ui.md]\n---\n");
    run(["commit", "--quiet", "-m", "fork"]);
    const from = run(["rev-parse", "HEAD"]);
    run(["mv", "docs/web-ui.md", "docs/10_web-ui.md"]);
    run(["commit", "--quiet", "-m", "upstream renames its docs"]);
    const to = run(["rev-parse", "HEAD"]);

    assert.strictEqual(commitUpstreamContextRenames(realRunner, root, from, to), true);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(root, workflow), "utf8"),
      "---\nname: UI\ncontext: [docs/10_web-ui.md]\n---\n",
    );
    assert.strictEqual(
      run(["log", "-1", "--format=%s%n%(trailers:only)"]),
      "chore(fork): follow upstream renames in rsi-agent workflow context\nFork-Domain: fork-meta\nFork-Tier: core",
    );
    assert.strictEqual(commitUpstreamContextRenames(realRunner, root, from, to), false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
