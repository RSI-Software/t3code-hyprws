// @effect-diagnostics nodeBuiltinImport:off - the tip proof reads real blobs through git.

// Pure fixtures: the re-apply stage decides from text alone, so every anchor rule is exercised
// without a lane. The last test is the standing proof of the derived model
// (RSI-Software/t3code-hyprws#1155): every hook the fork tip declares, re-applied onto the tip's
// own upstream base, reproduces the tip byte for byte.

import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";

import { reapplyForkHooks } from "./fork-hook-reapply.ts";
import { deriveForkHooks, readForkHookTree, type ForkHooksManifest } from "./fork-hooks.ts";

const after = (...context: ReadonlyArray<string>) => ({ context });

it("treats a marker that survived the upstream rewrite as intact", () => {
  const merged =
    'import { a } from "a";\nimport { forkThing } from "fork"; // fork-hook: dom/name\nconst x = a();\n';
  const fork = 'import { forkThing } from "fork"; // fork-hook: dom/name\n';
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/name", anchor: after('import { a } from "a";') },
  ]);
  assert.strictEqual(result.results[0]?.outcome.status, "intact");
  assert.strictEqual(result.reinserted.length, 0);
  assert.strictEqual(result.text, merged);
});

it("re-inserts a line hook directly after its context, marker exactly once", () => {
  const merged = "const session = startSession(opts);\nconst done = finish(session);\n";
  const fork = "const env = makeForkEnv(); // fork-hook: dom/env\n";
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/env", anchor: after("const session = startSession(opts);") },
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

it("places a collection member from the context inside the collection", () => {
  const merged = "export interface Options {\n  name: string;\n}\n";
  const fork = "  forkThing: string; // fork-hook: dom/opt\n";
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/opt", anchor: after("  name: string;") },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  assert.include(result.text, "  forkThing: string; // fork-hook: dom/opt\n}\n");
});

it("re-inserts a JSX pair whole, end marker placed with it", () => {
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
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/badge", anchor: after("      <Item />") },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  assert.strictEqual(result.text.split("fork-hook: dom/badge").length - 1, 1);
  assert.strictEqual(result.text.split("fork-hook-end").length - 1, 1);
  const inserted = result.text.split("\n");
  assert.strictEqual(inserted.indexOf("      <Badge />"), inserted.indexOf("    </MenuPopup>") - 2);
  assert.strictEqual(
    inserted[inserted.indexOf("    </MenuPopup>") - 1],
    "      {/* fork-hook-end */}",
  );
});

it("refuses an ambiguous context by hook key", () => {
  const merged = "startSession(a);\nrun();\nstartSession(a);\nrun();\n";
  const fork = "const env = makeForkEnv(); // fork-hook: dom/env\n";
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/env", anchor: after("startSession(a);") },
  ]);
  assert.deepInclude(result.results[0], {
    key: "dom/env",
    outcome: {
      status: "refuse",
      reason: "the hook's anchor context matches 2 sites; the anchor is ambiguous",
    },
  });
  assert.strictEqual(result.reinserted.length, 0);
  assert.strictEqual(result.text, merged);
});

it("refuses a context the merged text lost instead of falling back to the file end", () => {
  const merged = "const x = other();\n";
  const fork = "const env = makeForkEnv(); // fork-hook: dom/env\n";
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/env", anchor: after("const session = startSession(opts);") },
  ]);
  assert.deepInclude(result.results[0]?.outcome, {
    status: "refuse",
    reason: "the hook's anchor context is not in the merged text",
  });
});

it("matches a re-indented context and keeps the hook's own bytes", () => {
  const merged = "function go() {\n    run();\n}\n";
  const fork = "  forkRun(); // fork-hook: dom/run\n";
  const result = reapplyForkHooks(merged, fork, [{ key: "dom/run", anchor: after("  run();") }]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  assert.include(result.text, "    run();\n  forkRun(); // fork-hook: dom/run\n");
});

it("refuses a hook whose marker is unreadable in the fork text", () => {
  const merged = 'import { a } from "a";\n';
  const result = reapplyForkHooks(merged, 'import { forkThing } from "fork";\n', [
    { key: "dom/name", anchor: after('import { a } from "a";') },
  ]);
  assert.deepInclude(result.results[0]?.outcome, {
    status: "refuse",
    reason: "the fork side of this conflict carries no readable marker for the hook",
  });
});

it("applies several reinsertions at one anchor in the order given", () => {
  const merged = 'import { a } from "a";\nconst x = a();\n';
  const forkA = 'import { forkOne } from "one"; // fork-hook: dom/one\n';
  const forkB = 'import { forkTwo } from "two"; // fork-hook: dom/two\n';
  const result = reapplyForkHooks(merged, `${forkA}${forkB}`, [
    { key: "dom/one", anchor: after('import { a } from "a";') },
    { key: "dom/two", anchor: after('import { a } from "a";') },
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
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/name", anchor: after('import { a } from "a";') },
  ]);
  assert.deepInclude(result.results[0]?.outcome, { status: "reinsert" });
  const lines = result.text.split("\n");
  const at = lines.indexOf("import {");
  assert.strictEqual(at, 1);
  assert.strictEqual(lines[at + 1], "  forkThing,");
  assert.strictEqual(lines[at + 2], '} from "./fork.fork.ts"; // fork-hook: dom/name');
});

it("refuses a marker whose statement start cannot be proven", () => {
  const merged = 'import { a } from "a";\n';
  const fork = [
    "const stray = f(",
    '  "unterminated',
    '} from "./fork.fork.ts"; // fork-hook: dom/name',
    "",
  ].join("\n");
  const result = reapplyForkHooks(merged, fork, [
    { key: "dom/name", anchor: after('import { a } from "a";') },
  ]);
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
    [{ key: "dom/name", anchor: after('import { a } from "a";') }],
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
    [{ key: "dom/name", anchor: after('import { a } from "a";') }],
    { spans: new Map([["dom/name", span]]) },
  );
  assert.deepStrictEqual(result.reinserted, ["dom/name"]);
  // The marked line was read, not the overlay span's line 2.
  assert.include(result.text, 'import { forkThing } from "fork"; // fork-hook: dom/name');
  assert.isFalse(result.text.includes("const other"));
});

/**
 * The fork tip's own hooks, re-applied onto the base they were written against. Every hooked file
 * is proven against the text the hooks were woven into — the tip with every marked span removed,
 * which is what an upstream file looks like before the fork touches it — and, for the files whose
 * upstream blob is exactly that text, against the real upstream blob as well.
 */
const git = (...argv: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...argv], { encoding: "utf8", maxBuffer: 1 << 28 });

it("re-applies every hook the fork tip declares onto its base, byte for byte", () => {
  const tree = readForkHookTree();
  const manifest = deriveForkHooks(tree);
  assert.isAbove(manifest.length, 100, "the tip must declare the fork's hooks");
  // CI checks this package out shallow and without an `upstream` remote, so the upstream-blob
  // subset is opportunistic; the woven base needs no history and always runs.
  const base = ((): string | null => {
    try {
      git("rev-parse", "--verify", "--quiet", "upstream/main");
      return git("merge-base", "HEAD", "upstream/main").trim();
    } catch {
      return null;
    }
  })();
  const byPath = new Map<string, Array<ForkHooksManifest[number]>>();
  for (const entry of manifest) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);
  const reapply = (into: string, tip: string, entries: ReadonlyArray<ForkHooksManifest[number]>) =>
    reapplyForkHooks(
      into,
      tip,
      entries.map((entry) => ({ key: entry.key, anchor: entry.anchor, span: entry.span })),
    );
  /** The first line the re-applied text and the tip disagree on, with its neighbourhood. */
  const firstDrift = (got: string, want: string): string => {
    const left = got.split("\n");
    const right = want.split("\n");
    const at = left.findIndex((line, index) => line !== right[index]);
    if (at === -1) return "";
    return ` first drift at line ${at + 1}: got ${JSON.stringify(left.slice(at, at + 3))} want ${JSON.stringify(right.slice(at, at + 3))}`;
  };
  const refusals = (result: ReturnType<typeof reapply>) =>
    result.results
      .filter(({ outcome }) => outcome.status === "refuse")
      .map(({ key, outcome }) => `${key}: ${outcome.status === "refuse" ? outcome.reason : ""}`)
      .join("; ");
  let againstUpstream = 0;
  for (const [path, entries] of byPath) {
    const tip = tree.get(path) ?? "";
    const marked = new Set<number>();
    for (const entry of entries)
      for (let line = entry.span.startLine; line <= entry.span.endLine; line += 1) marked.add(line);
    const woven = tip
      .split("\n")
      .filter((_, index) => !marked.has(index + 1))
      .join("\n");
    const onWoven = reapply(woven, tip, entries);
    assert.strictEqual(
      onWoven.text,
      tip,
      `${path} (woven base): ${refusals(onWoven)}${firstDrift(onWoven.text, tip)}`,
    );
    if (base === null) continue;
    let upstream: string;
    try {
      upstream = git("show", `${base}:${path}`);
    } catch {
      continue; // fork-added file: no upstream blob to re-apply onto
    }
    if (upstream !== woven) continue; // the fork also changed non-hook lines in this file
    const onUpstream = reapply(upstream, tip, entries);
    assert.strictEqual(
      onUpstream.text,
      tip,
      `${path} (upstream base): ${refusals(onUpstream)}${firstDrift(onUpstream.text, tip)}`,
    );
    againstUpstream += 1;
  }
  if (base !== null) assert.isAbove(againstUpstream, 0, "no hooked file matched its upstream base");
});
