// Pure fixtures: the license-list merge decides from the three stages' text alone.

import { assert, it } from "@effect/vitest";

import { mergeLicenseLists } from "./fork-license-merge.ts";

type Entry = { readonly name: string; readonly license?: string };

const list = (customNotices: ReadonlyArray<Entry>, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ ...extra, customNotices }, null, 2)}\n`;

const merged = (stages: Parameters<typeof mergeLicenseLists>[0]): unknown => {
  const result = mergeLicenseLists(stages);
  if ("refuseReason" in result) throw new Error(`refused: ${result.refuseReason}`);
  return JSON.parse(result.text);
};

const refusal = (stages: Parameters<typeof mergeLicenseLists>[0]): string => {
  const result = mergeLicenseLists(stages);
  if (!("refuseReason" in result)) throw new Error("merged");
  return result.refuseReason;
};

const base = list([{ name: "a" }, { name: "b" }]);

it("keeps both sides' appends: upstream's order, then the fork's additions", () => {
  assert.deepStrictEqual(
    merged({
      base,
      upstream: list([{ name: "a" }, { name: "b" }, { name: "up-1" }, { name: "up-2" }]),
      fork: list([{ name: "fork-2" }, { name: "a" }, { name: "b" }, { name: "fork-1" }]),
    }),
    {
      customNotices: [
        { name: "a" },
        { name: "b" },
        { name: "up-1" },
        { name: "up-2" },
        { name: "fork-2" },
        { name: "fork-1" },
      ],
    },
  );
});

it("takes one side's edit or delete of an entry the other left alone", () => {
  assert.deepStrictEqual(
    merged({
      base,
      upstream: list([{ name: "a", license: "MIT" }, { name: "b" }]),
      fork: list([{ name: "a" }, { name: "fork-1" }]),
    }),
    { customNotices: [{ name: "a", license: "MIT" }, { name: "fork-1" }] },
  );
});

it("merges a list both sides added without a base", () => {
  assert.deepStrictEqual(
    merged({ base: null, upstream: list([{ name: "up" }]), fork: list([{ name: "fork" }]) }),
    { customNotices: [{ name: "up" }, { name: "fork" }] },
  );
});

it("merges top-level keys three ways and appends the fork's new keys", () => {
  assert.deepStrictEqual(
    merged({
      base: list([], { version: 1 }),
      upstream: list([], { version: 2 }),
      fork: list([], { version: 1, forkOnly: true }),
    }),
    { version: 2, customNotices: [], forkOnly: true },
  );
});

it("keys an entry without a name on its repositoryUrl", () => {
  const url = (repositoryUrl: string, license?: string) => ({ repositoryUrl, license });
  const overrides = (packageOverrides: ReadonlyArray<object>) =>
    `${JSON.stringify({ packageOverrides }, null, 2)}\n`;
  assert.deepStrictEqual(
    merged({
      base: overrides([url("https://x/a")]),
      upstream: overrides([url("https://x/a", "MIT"), url("https://x/up")]),
      fork: overrides([url("https://x/a"), { name: "fork" }]),
    }),
    {
      packageOverrides: [
        { repositoryUrl: "https://x/a", license: "MIT" },
        { repositoryUrl: "https://x/up" },
        { name: "fork" },
      ],
    },
  );
});

it("refuses an entry both sides changed apart", () => {
  assert.strictEqual(
    refusal({
      base,
      upstream: list([{ name: "a", license: "MIT" }, { name: "b" }]),
      fork: list([{ name: "a", license: "ISC" }, { name: "b" }]),
    }),
    'both sides changed customNotices entry "a"',
  );
});

it("refuses a delete of an entry the other side changed", () => {
  assert.strictEqual(
    refusal({
      base,
      upstream: list([{ name: "b" }]),
      fork: list([{ name: "a", license: "MIT" }, { name: "b" }]),
    }),
    'one side deleted customNotices entry "a" the other changed',
  );
});

it("refuses a deleted file, an unnamed or duplicate entry, and invalid JSON", () => {
  assert.strictEqual(
    refusal({ base, upstream: null, fork: base }),
    "the upstream side deleted the file",
  );
  assert.strictEqual(
    refusal({ base, upstream: base, fork: list([{ name: "a" }, { name: "a" }]) }),
    'customNotices names "a" twice',
  );
  assert.strictEqual(
    refusal({ base, upstream: base, fork: `{"customNotices":[{"license":"MIT"}]}` }),
    "a customNotices entry has no string name or repositoryUrl",
  );
  assert.match(refusal({ base, upstream: base, fork: "{" }), /JSON/);
});
