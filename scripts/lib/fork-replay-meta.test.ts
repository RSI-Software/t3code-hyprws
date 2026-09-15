import "./fork-test-quiet.ts";

import { assert, it } from "@effect/vitest";

import {
  excludeStartEmpty,
  parseReplayMeta,
  replayMetaArguments,
  startEmptyShas,
} from "./fork-replay-meta.ts";

const record = (raw: string) => parseReplayMeta(raw)[0]!;

it("replayMetaArguments reads sha, tree, parents and message over the range with its boundary", () => {
  assert.deepStrictEqual(replayMetaArguments("aaa", "bbb"), [
    "log",
    "--boundary",
    "--reverse",
    "--topo-order",
    "--format=%H%x20%T%x20%P%x1f%B%x1e",
    "aaa..bbb",
  ]);
});

it("parseReplayMeta splits records into sha, tree, parents, message and boundary flag", () => {
  const raw = [
    "c1 t1\x1froot message\n\x1e",
    "c2 t2 c1\x1fchild message\n\x1e",
    "-c0 t0 c1\x1fboundary message\n\x1e",
    "\n",
  ].join("");
  // The trailing separator newline git appends parses to no phantom record.
  const records = parseReplayMeta(raw);
  assert.deepStrictEqual(records, [
    { sha: "c1", tree: "t1", parents: [], message: "root message\n", boundary: false },
    { sha: "c2", tree: "t2", parents: ["c1"], message: "child message\n", boundary: false },
    { sha: "c0", tree: "t0", parents: ["c1"], message: "boundary message\n", boundary: true },
  ]);
  assert.deepStrictEqual(parseReplayMeta(""), []);
  // `--boundary` prints the range base with the same format and no marker on every git version,
  // so the caller names it and the record is flagged boundary.
  const withBase = parseReplayMeta(
    ["c1 t1 b0\x1froot message\n\x1e", "b0 t0\x1fbase\n\x1e"].join(""),
    "b0",
  );
  assert.deepStrictEqual(
    withBase.map(({ sha, boundary }) => ({ sha, boundary })),
    [
      { sha: "c1", boundary: false },
      { sha: "b0", boundary: true },
    ],
  );
});

it("startEmptyShas keeps changed commits, root commits and merges, and reads parent trees from boundary records", () => {
  const records = [
    record("-base tb\x1fbase\n\x1e"),
    record("r1 tb base\x1fempty after base\n\x1e"),
    record("r2 t2 r1\x1fchanged\n\x1e"),
    record("r3 t2 r2\x1fempty after r2\n\x1e"),
    record("r4 t4 r2 r9\x1fmerge\n\x1e"),
  ];
  assert.deepStrictEqual([...startEmptyShas(records)].sort(), ["r1", "r3"]);
});

it("excludeStartEmpty drops the start-empty records from the series and the count", () => {
  const records = [
    record("c1 t1\x1fa message\n\x1e"),
    record("c2 t2 c1\x1fb message\n\x1e"),
    record("c3 t2 c2\x1fc message\n\x1e"),
  ];
  assert.deepStrictEqual(
    excludeStartEmpty("a message\n\x1eb message\n\x1ec message\n\x1e", 3, records),
    { messages: "a message\n\x1eb message\n\x1e", count: 2 },
  );
});

it("excludeStartEmpty strips the dropped first record's separating newline like the repair filter", () => {
  const records = [
    record("-b0 t0\x1fbase\n\x1e"),
    record("c1 t0 b0\x1fa message\n\x1e"),
    record("c2 t2 c1\x1fb message\n\x1e"),
  ];
  assert.deepStrictEqual(excludeStartEmpty("a message\n\x1eb message\n\x1e", 2, records), {
    messages: "b message\n\x1e",
    count: 1,
  });
});

it("excludeStartEmpty stays conservative when the records do not align with the stored series", () => {
  const messages = "a message\n\x1eb message\n\x1e";
  assert.deepStrictEqual(excludeStartEmpty(messages, 2, [record("c1 t1\x1fa message\n\x1e")]), {
    messages,
    count: 2,
  });
  assert.deepStrictEqual(excludeStartEmpty(messages, 2, []), { messages, count: 2 });
});

it("excludeStartEmpty leaves a series with no start-empty commits untouched", () => {
  const messages = "a message\n\x1eb message\n\x1e";
  assert.deepStrictEqual(
    excludeStartEmpty(messages, 2, [
      record("c1 t1\x1fa message\n\x1e"),
      record("c2 t2 c1\x1fb message\n\x1e"),
    ]),
    { messages, count: 2 },
  );
});
