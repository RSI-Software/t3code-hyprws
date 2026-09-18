// @effect-diagnostics nodeBuiltinImport:off - Digest stability is asserted against the hash itself.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { assessSeams, seamIdentity, type CensusFile } from "./lib/fork-churn-seams.ts";
import {
  censusCarryCost,
  censusShapeSplit,
  parseSequentialCensusEvidence,
  requireSequentialCensusEvidence,
  type SequentialCensusEvidence,
} from "./lib/fork-rebase-issues.ts";

const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40),
  D = "d".repeat(40);

type Row = SequentialCensusEvidence["rows"][number];

const row = (overrides: Partial<Row> & Pick<Row, "path">): Row => ({
  stop: 1,
  commit: A,
  subject: "feat: preserve fork intent",
  domain: "fork-meta",
  kind: "content",
  ...overrides,
});

const evidence = (version: 1 | 2, rows: ReadonlyArray<Row>): SequentialCensusEvidence => ({
  version,
  method: "sequential-rebase-walk-resolution",
  sourceSha: A,
  baseSha: D,
  targetSha: C,
  targetTag: "v1.0.0",
  complete: true,
  rows: rows.map((item, index) => ({ ...item, stop: index + 1 })),
});

const snapshot = (value: SequentialCensusEvidence) => ({
  tag: value.targetTag,
  fixedAt: null,
  files: value.rows.map((item) => ({
    path: item.path,
    hunks: null,
    commit: item.commit,
    subject: item.subject,
    domain: item.domain ?? "?",
    ...(item.hooks === undefined ? {} : { hooks: item.hooks }),
  })),
  censusEvidence: value,
});

it("keys a v1 row on its location, at the digest every stored record already carries", () => {
  const file: CensusFile = {
    path: "apps/web/src/seam.tsx",
    hunks: null,
    commit: A,
    subject: "feat: preserve fork intent",
    domain: "fork-meta",
  };
  // Spelled out rather than imported: a stored observation is re-digested from its parsed payload,
  // so this is the hash every historical seam id was minted from and it may never move.
  assert.strictEqual(
    seamIdentity(file),
    NodeCrypto.createHash("sha256")
      .update(JSON.stringify(JSON.stringify([file.path, file.subject, file.domain])))
      .digest("hex"),
  );
});

it("keys a hooked row on its manifest keys, so a path or subject rewrite keeps the seam", () => {
  const hooks = ["github-issues/issue-row", "github-issues/issue-title"];
  const moved: CensusFile = {
    path: "apps/web/src/moved.tsx",
    hunks: null,
    commit: B,
    subject: "refactor: rename the row",
    domain: "github-issues",
    hooks,
  };
  const original: CensusFile = {
    path: "apps/web/src/seam.tsx",
    hunks: null,
    commit: A,
    subject: "feat: preserve fork intent",
    domain: "github-issues",
    hooks,
  };
  assert.strictEqual(seamIdentity(moved), seamIdentity(original));
  assert.notStrictEqual(
    seamIdentity(original),
    seamIdentity({ ...original, hooks: ["github-issues/issue-row"] }),
  );
  // Order is not identity: the key set is.
  assert.strictEqual(seamIdentity(original), seamIdentity({ ...original, hooks: [...hooks].reverse() }));
  // An unhooked row in the same place keeps the location identity, so v1 records are untouched.
  const { hooks: _hooks, ...unhooked } = original;
  assert.notStrictEqual(seamIdentity(original), seamIdentity(unhooked));
});

it("version-gates the shape fields in both directions", () => {
  const hooked = row({ path: "seam.ts", shape: "hooked", hooks: ["upstream-fixes/patch"] });
  assert.doesNotThrow(() => requireSequentialCensusEvidence(evidence(2, [hooked])));
  assert.doesNotThrow(() => requireSequentialCensusEvidence(evidence(1, [row({ path: "seam.ts" })])));
  assert.throws(
    () => requireSequentialCensusEvidence(evidence(1, [hooked])),
    /v1 row carries v2 shape fields/,
  );
  assert.throws(
    () => requireSequentialCensusEvidence(evidence(2, [row({ path: "seam.ts" })])),
    /records no shape/,
  );
  assert.throws(
    () => requireSequentialCensusEvidence(evidence(2, [{ ...hooked, hooks: undefined }])),
    /names no hook/,
  );
  assert.throws(
    () => requireSequentialCensusEvidence(evidence(2, [{ ...row({ path: "x" }), shape: "woven", hooks: ["a/b"] }])),
    /hooks on an unhooked row/,
  );
  assert.throws(
    () => requireSequentialCensusEvidence(evidence(2, [{ ...hooked, hooks: ["b/b", "a/a"] }])),
    /hooks are not sorted/,
  );
  assert.throws(
    () => requireSequentialCensusEvidence(evidence(2, [{ ...hooked, hooks: ["a/a", "a/a"] }])),
    /hooks repeat a key/,
  );
});

it("parses both stored marker versions and never materialises an absent field", () => {
  const stored = evidence(1, [row({ path: "seam.ts" })]);
  const parsed = parseSequentialCensusEvidence(
    `prose\n<!-- sequential-census-v1:${JSON.stringify(stored)} -->\n`,
  );
  assert.deepStrictEqual(parsed, stored);
  assert.isFalse(Object.hasOwn(parsed!.rows[0]!, "shape"));
  assert.isFalse(Object.hasOwn(parsed!.rows[0]!, "hooks"));
  const second = evidence(2, [row({ path: "seam.ts", shape: "woven" })]);
  assert.deepStrictEqual(
    parseSequentialCensusEvidence(`<!-- sequential-census-v2:${JSON.stringify(second)} -->`),
    second,
  );
  assert.isFalse(Object.hasOwn(parseSequentialCensusEvidence(`<!-- sequential-census-v2:${JSON.stringify(second)} -->`)!.rows[0]!, "hooks"));
});

it("counts carry cost by distinct woven path, and says when a domain was never measured", () => {
  const rows = [
    row({ path: "a.ts", domain: "upstream-fixes", shape: "woven" }),
    row({ path: "a.ts", domain: "upstream-fixes", shape: "woven", commit: B }),
    row({ path: "b.ts", domain: "upstream-fixes", shape: "hooked", hooks: ["upstream-fixes/patch"] }),
    row({ path: "c.ts", domain: "custom-agents", shape: "addition" }),
  ];
  const [first, second] = censusCarryCost(evidence(2, rows).rows);
  assert.deepStrictEqual(
    { domain: first!.domain, measured: first!.measured, recurring: first!.recurring, retirable: first!.retirable },
    { domain: "upstream-fixes", measured: true, recurring: 1, retirable: 1 },
  );
  assert.strictEqual(first!.conflictFileCount, 3);
  assert.strictEqual(first!.forkCommitCount, 2);
  assert.deepStrictEqual(
    { domain: second!.domain, recurring: second!.recurring, owned: second!.owned },
    { domain: "custom-agents", recurring: 0, owned: 1 },
  );
  const legacy = censusCarryCost(evidence(1, [row({ path: "a.ts", domain: "upstream-fixes" })]).rows);
  assert.isFalse(legacy[0]!.measured);
  assert.strictEqual(censusShapeSplit(evidence(2, rows).rows).unclassifiedFileCount, 0);
});

it("cannot establish absence across the identity-scheme boundary", () => {
  const located = row({ path: "seam.ts" });
  const verdicts = assessSeams(
    [
      snapshot(evidence(1, [located])),
      snapshot(evidence(2, [row({ path: "seam.ts", shape: "hooked", hooks: ["upstream-fixes/patch"] })])),
    ],
    [],
  );
  const carried = verdicts.find((verdict) => verdict.status !== "observed");
  assert.strictEqual(carried?.status, "unknown");
  assert.isFalse(carried.blocking);
  assert.match(carried.reason, /identity scheme/);
  // The v2 row is its own observed identity rather than a silent replacement of the v1 one.
  assert.strictEqual(verdicts.filter((verdict) => verdict.status === "observed").length, 1);
});
