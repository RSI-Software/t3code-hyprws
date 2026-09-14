// @effect-diagnostics nodeBuiltinImport:off - Drives the real guard CLI as a subprocess with temp fixture bodies.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { findUpstreamReferences, renderReferences } from "./fork-upstream-refs.ts";

const lines = (...input: ReadonlyArray<string>) => input.join("\n");

const texts = (body: string) => findUpstreamReferences(body).map((reference) => reference.text);

it("fails a bare upstream number outside a code span or fence", () => {
  const references = findUpstreamReferences(
    lines("Upstream context.", "", "The regression landed in #4379 last week."),
  );
  assert.deepStrictEqual(references, [
    {
      kind: "number",
      text: "#4379",
      line: 3,
      column: 26,
    },
  ]);
  assert.strictEqual(
    renderReferences(references),
    "3:26 #4379 (bare item number, resolved upstream when this fork has no such item)\n",
  );
});

it("passes the item in a code span and the fork item in full form", () => {
  assert.deepStrictEqual(
    texts("Cite `pingdotgg/t3code#4379`, not RSI-Software/t3code-hyprws#108."),
    [],
  );
});

it("passes a pasted survey inside one fenced block", () => {
  assert.deepStrictEqual(
    texts(
      lines(
        "The upstream survey:",
        "",
        "```text",
        "pingdotgg/t3code#4379 files explorer tab",
        "```",
        "",
        "It is already carried here.",
      ),
    ),
    [],
  );
});

it("fails a cross-repo reference and an upstream item URL", () => {
  assert.deepStrictEqual(
    texts("pingdotgg/t3code#4379 and github.com/pingdotgg/t3code/issues/4402 are live."),
    ["pingdotgg/t3code#4379", "github.com/pingdotgg/t3code/issues/4402"],
  );
});

it("names the unreadable file without claiming zero references", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-refs-"));
  try {
    const clean = NodePath.join(dir, "clean.md");
    const missing = NodePath.join(dir, "missing.md");
    NodeFS.writeFileSync(clean, "No references here.\n");
    const result = NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [NodePath.join(import.meta.dirname, "fork-upstream-refs.ts"), clean, missing],
      { encoding: "utf8" },
    );
    assert.strictEqual(result.status, 1);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.include(output, `cannot read ${missing}`);
    assert.include(output, "1 unreadable file(s) in 1 of 2 file(s)");
    assert.notInclude(output, "live upstream reference(s)");
  } finally {
    NodeFS.rmSync(dir, { force: true, recursive: true });
  }
});

it("prints a single ok line for a single clean file", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-refs-"));
  try {
    const clean = NodePath.join(dir, "clean.md");
    NodeFS.writeFileSync(clean, "No references here.\n");
    const result = NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [NodePath.join(import.meta.dirname, "fork-upstream-refs.ts"), clean],
      { encoding: "utf8" },
    );
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout ?? "", `ok: no live upstream references in ${clean}\n`);
  } finally {
    NodeFS.rmSync(dir, { force: true, recursive: true });
  }
});

it("fails the run when the dirty file comes second", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-refs-"));
  try {
    const clean = NodePath.join(dir, "clean.md");
    const dirty = NodePath.join(dir, "live-ref.md");
    NodeFS.writeFileSync(clean, "No references here.\n");
    NodeFS.writeFileSync(dirty, "The regression landed in pingdotgg/t3code#7253 last week.\n");
    const result = NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [NodePath.join(import.meta.dirname, "fork-upstream-refs.ts"), clean, dirty],
      { encoding: "utf8" },
    );
    assert.strictEqual(result.status, 1);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, new RegExp(`in 1 of 2 file\\(s\\)`));
    assert.include(output, dirty);
  } finally {
    NodeFS.rmSync(dir, { force: true, recursive: true });
  }
});
