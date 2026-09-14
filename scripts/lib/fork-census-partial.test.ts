// @effect-diagnostics nodeBuiltinImport:off - Exercises a file the fork bot writes without Effect.
import "./fork-test-quiet.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  censusPartialDir,
  CensusPartialRecord,
  type CensusPartial,
} from "./fork-census-partial.ts";
import type { SequentialCensusEvidence } from "./fork-rebase-issues.ts";

const SOURCE = "1".repeat(40);
const TARGET = "2".repeat(40);

const evidence = (rows: number): SequentialCensusEvidence => ({
  version: 1,
  method: "sequential-rebase-stage3-provisional",
  sourceSha: SOURCE,
  baseSha: "3".repeat(40),
  targetSha: TARGET,
  targetTag: "v1.0.0",
  complete: false,
  rows: Array.from({ length: rows }, (_unused, index) => ({
    stop: index + 1,
    commit: SOURCE,
    subject: "feat(test): fork change",
    domain: "fork-meta",
    path: `conflicted-${String(index)}.txt`,
    kind: "content" as const,
    stage: "unresolved" as const,
  })),
});

const inTemporaryDir = (run: (root: string) => void): void => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-census-partial-test-"));
  try {
    run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

const read = (path: string): CensusPartial => JSON.parse(NodeFS.readFileSync(path, "utf8"));

/** The suite runs quiet; a test that asserts on the operator's stream turns that off. */
const spoken = (run: () => void): Array<string> => {
  const lines: Array<string> = [];
  const original = process.stderr.write.bind(process.stderr);
  const quiet = process.env.FORK_QUIET;
  delete process.env.FORK_QUIET;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
    if (quiet === undefined) delete process.env.FORK_QUIET;
    else process.env.FORK_QUIET = quiet;
  }
  return lines;
};

it("keeps the rows a walk has observed, under the repository's run evidence", () => {
  inTemporaryDir((root) => {
    const record = new CensusPartialRecord(root, { sourceSha: SOURCE, targetSha: TARGET });
    assert.strictEqual(
      NodePath.dirname(record.path),
      NodePath.join(root, ".dump/runs/fork-census"),
    );
    record.record(evidence(2), "stop-limit");
    const partial = read(record.path);
    assert.strictEqual(partial.schemaVersion, 1);
    assert.strictEqual(partial.pid, process.pid);
    assert.strictEqual(partial.truncatedBy, "stop-limit");
    assert.deepStrictEqual(partial.evidence.rows, evidence(2).rows);
  });
});

it("rewrites no faster than once a second, and always for the last write", () => {
  inTemporaryDir((root) => {
    let clock = 10_000;
    const record = new CensusPartialRecord(
      root,
      { sourceSha: SOURCE, targetSha: TARGET },
      () => clock,
    );
    record.record(evidence(1), null);
    assert.strictEqual(read(record.path).evidence.rows.length, 1);
    clock += 200;
    record.record(evidence(2), null);
    assert.strictEqual(read(record.path).evidence.rows.length, 1);
    clock += 900;
    record.record(evidence(3), null);
    assert.strictEqual(read(record.path).evidence.rows.length, 3);
    clock += 10;
    record.record(evidence(4), "time-limit", true);
    assert.strictEqual(read(record.path).evidence.rows.length, 4);
    assert.strictEqual(read(record.path).truncatedBy, "time-limit");
  });
});

it("gives two censuses two files", () => {
  inTemporaryDir((root) => {
    const key = { sourceSha: SOURCE, targetSha: TARGET };
    const first = new CensusPartialRecord(root, key);
    const second = new CensusPartialRecord(root, key);
    assert.notStrictEqual(first.path, second.path);
    first.record(evidence(1), null);
    second.record(evidence(2), null);
    assert.strictEqual(read(first.path).evidence.rows.length, 1);
    assert.strictEqual(read(second.path).evidence.rows.length, 2);
  });
});

it("takes the directory an operator or a test points it at", () => {
  inTemporaryDir((root) => {
    const elsewhere = NodePath.join(root, "evidence");
    process.env.FORK_CENSUS_PARTIAL_DIR = elsewhere;
    try {
      assert.strictEqual(censusPartialDir(root), elsewhere);
      const record = new CensusPartialRecord(root, { sourceSha: SOURCE, targetSha: TARGET });
      record.record(evidence(1), null);
      assert.strictEqual(NodePath.dirname(record.path), elsewhere);
      assert.strictEqual(read(record.path).evidence.rows.length, 1);
    } finally {
      delete process.env.FORK_CENSUS_PARTIAL_DIR;
    }
  });
});

it("lets a walk finish even when its rows cannot be kept", () => {
  inTemporaryDir((root) => {
    const blocked = NodePath.join(root, "blocked");
    NodeFS.writeFileSync(blocked, "not a directory\n");
    process.env.FORK_CENSUS_PARTIAL_DIR = NodePath.join(blocked, "census");
    let record: CensusPartialRecord | null = null;
    const written = spoken(() => {
      record = new CensusPartialRecord(root, { sourceSha: SOURCE, targetSha: TARGET });
      record.record(evidence(1), null);
      record.record(evidence(2), null, true);
    });
    delete process.env.FORK_CENSUS_PARTIAL_DIR;
    assert.strictEqual(NodeFS.existsSync(record!.path), false);
    assert.strictEqual(written.length, 1);
    assert.match(written[0] ?? "", /^census: partial rows are not being kept \(/);
  });
});
