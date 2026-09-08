import { assert, it } from "@effect/vitest";

import { buildWalkSize } from "./fork-walk-size.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

it("records total commits, the per-domain table, and the shared-file count", () => {
  const size = buildWalkSize({
    commits: [
      { sha: SHA_A, domain: "zmux-estate" },
      { sha: SHA_B, domain: "fork-meta" },
    ],
    statsBySha: new Map([
      [SHA_A, { files: ["apps/web/src/app.ts", "shared.ts"], added: 5, deleted: 1 }],
      [SHA_B, { files: ["docs/internals/fork-delta.md"], added: 2, deleted: 0 }],
    ]),
    forkChanged: new Set(["apps/web/src/app.ts", "shared.ts", "docs/internals/fork-delta.md"]),
    upstreamChanged: new Set(["shared.ts"]),
  });
  assert.deepStrictEqual(size, {
    commits: 2,
    domains: [
      {
        domain: "fork-meta",
        commits: 1,
        added: 2,
        deleted: 0,
        shared: 0,
      },
      {
        domain: "zmux-estate",
        commits: 1,
        added: 5,
        deleted: 1,
        shared: 1,
      },
    ],
    sharedFiles: 1,
  });
});

it("dedupes a file two commits of one domain touch and sums the domain shares", () => {
  const size = buildWalkSize({
    commits: [
      { sha: SHA_A, domain: "fork-meta" },
      { sha: SHA_B, domain: "fork-meta" },
    ],
    statsBySha: new Map([
      [SHA_A, { files: ["shared.ts"], added: 1, deleted: 0 }],
      [SHA_B, { files: ["shared.ts"], added: 0, deleted: 1 }],
    ]),
    forkChanged: new Set(["shared.ts"]),
    upstreamChanged: new Set(["shared.ts"]),
  });
  assert.deepStrictEqual(size.domains, [
    { domain: "fork-meta", commits: 2, added: 1, deleted: 1, shared: 1 },
  ]);
  assert.strictEqual(size.sharedFiles, 1);
});

it("counts untagged commits in the total without inventing a domain row", () => {
  const size = buildWalkSize({
    commits: [{ sha: SHA_A }],
    statsBySha: new Map([["b".repeat(40), { files: [], added: 0, deleted: 0 }]]),
    forkChanged: new Set(),
    upstreamChanged: new Set(),
  });
  assert.strictEqual(size.commits, 1);
  assert.deepStrictEqual(size.domains, []);
  assert.strictEqual(size.sharedFiles, 0);
});
