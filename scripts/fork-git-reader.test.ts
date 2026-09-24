import { assert, it } from "@effect/vitest";

import {
  commitFilesArguments,
  parseCommitFiles,
  matchReplayCounterparts,
  squashedMembers,
  withFixupOwnerTrailers,
  resolveGuardedCommits,
} from "./fork-git-reader.ts";

const RS = "";

it("pairs each commit with the files it touches", () => {
  const raw = `${RS}aaa\n\nfirst.ts\nsecond.ts\n${RS}bbb\n\nthird.ts\n`;
  assert.deepStrictEqual(
    [...parseCommitFiles(raw)],
    [
      ["aaa", ["first.ts", "second.ts"]],
      ["bbb", ["third.ts"]],
    ],
  );
  assert.deepStrictEqual(commitFilesArguments(["aaa"]).slice(2, 4), ["show", "--name-only"]);
});

it("keeps every bounded replay commit for line-level guard filtering", () => {
  const commits = [
    {
      sha: "same",
      short: "same",
      subject: "feat: same",
      domain: "example",
      tier: "core",
    },
    {
      sha: "changed",
      short: "changed",
      subject: "feat: changed",
      domain: "example",
      tier: "core",
    },
    {
      sha: "new",
      short: "new",
      subject: "feat: new",
      domain: "example",
      tier: "core",
    },
    {
      sha: "duplicate",
      short: "duplicate",
      subject: "feat: duplicate",
      domain: "example",
      tier: "core",
    },
  ];
  const git = {
    run: (args: ReadonlyArray<string>) => {
      assert.deepStrictEqual(args, ["rev-list", "since..head"]);
      return commits.map(({ sha }) => sha).join("\n");
    },
  };
  const options = {
    base: null,
    head: "head",
    target: "target",
    typecheck: false,
    since: "since",
    replayOf: "origin/hyprws",
  } as const;
  const range = { base: "base", head: "head", target: "target" };

  assert.deepStrictEqual(
    resolveGuardedCommits(git, options, range, commits).map(({ sha }) => sha),
    ["same", "changed", "new", "duplicate"],
  );
});

it("matches duplicate replay subjects by oldest-first ordinal", () => {
  const matches = matchReplayCounterparts(
    [
      { sha: "replayed-1", subject: "duplicate" },
      { sha: "replayed-2", subject: "other" },
      { sha: "replayed-3", subject: "duplicate" },
      { sha: "replayed-surplus", subject: "duplicate" },
    ],
    new Map([
      ["duplicate", ["original-1", "original-2"]],
      ["other", ["original-other"]],
    ]),
  );
  assert.deepStrictEqual(
    [...matches],
    [
      ["replayed-1", ["original-1"]],
      ["replayed-2", ["original-other"]],
      ["replayed-3", ["original-2"]],
    ],
  );
});

it("reads the squashed members a rewrite lists, ignoring surrounding prose", () => {
  assert.deepStrictEqual(
    squashedMembers(
      "Squashes:\n\n- 9f318b69a9 fix(fork): one\n- ea63ce4dae fix(fork): two\n\nFork-Domain: distribution\n",
    ),
    ["9f318b69a9", "ea63ce4dae"],
  );
  assert.deepStrictEqual(squashedMembers("Squashes: none listed\n\nFork-Domain: x\n"), []);
  assert.deepStrictEqual(squashedMembers("Fork-Domain: x\n"), []);
});

it("matches every squashed member by sha prefix and leaves the subject ordinal alone", () => {
  const matches = matchReplayCounterparts(
    [
      { sha: "squash", subject: "duplicate", squashes: ["aaaa111", "bbbb222"] },
      { sha: "plain", subject: "duplicate" },
      { sha: "unlisted", subject: "other", squashes: ["ffff999"] },
    ],
    new Map([
      ["duplicate", ["aaaa1111111", "bbbb2222222"]],
      ["other", ["cccc3333333"]],
    ]),
    ["aaaa1111111", "bbbb2222222", "cccc3333333"],
  );
  assert.deepStrictEqual(
    [...matches],
    [
      ["squash", ["aaaa1111111", "bbbb2222222"]],
      ["plain", ["aaaa1111111"]],
      ["unlisted", ["cccc3333333"]],
    ],
  );
});

it("adds the fixups the sync folds into an owner to its replay match", () => {
  const matches = matchReplayCounterparts(
    [
      { sha: "replayed-owner", subject: "fix: owner" },
      { sha: "replayed-squash", subject: "fix: squash", squashes: ["aaaa111"] },
    ],
    new Map([
      ["fix: owner", ["original-owner"]],
      ["fixup! fix: owner", ["original-fixup-1", "original-fixup-2"]],
      ["fix: squash", ["aaaa1111111"]],
      ["fixup! fix: squash", ["original-squash-fixup"]],
    ]),
    ["aaaa1111111"],
  );
  assert.deepStrictEqual(
    [...matches],
    [
      ["replayed-owner", ["original-owner", "original-fixup-1", "original-fixup-2"]],
      ["replayed-squash", ["aaaa1111111", "original-squash-fixup"]],
    ],
  );
});

it("reads a squash-landed fixup as the owner it names", () => {
  const matches = matchReplayCounterparts(
    [
      { sha: "replayed-owner", subject: "fix: owner" },
      { sha: "replayed-numbered", subject: "fix: numbered (#219)" },
    ],
    new Map([
      ["fix: owner", ["original-owner"]],
      ["fixup! fix: owner (#1600)", ["landed-fixup"]],
      ["fix: numbered (#219)", ["original-numbered"]],
      ["fixup! fix: numbered (#219)", ["direct-fixup"]],
      ["fixup! fix: numbered (#219) (#1601)", ["landed-numbered-fixup"]],
    ]),
  );
  assert.deepStrictEqual(
    [...matches],
    [
      ["replayed-owner", ["original-owner", "landed-fixup"]],
      ["replayed-numbered", ["original-numbered", "direct-fixup", "landed-numbered-fixup"]],
    ],
  );
  assert.deepStrictEqual(
    withFixupOwnerTrailers([
      { sha: "owner", short: "owner", subject: "fix: owner", domain: "example", tier: "core" },
      { sha: "fixup", short: "fixup", subject: "fixup! fix: owner (#1600)" },
    ]).map(({ sha, domain, tier }) => ({ sha, domain, tier })),
    [
      { sha: "owner", domain: "example", tier: "core" },
      { sha: "fixup", domain: "example", tier: "core" },
    ],
  );
});

it("scans a trailer-free fixup as the commit it names", () => {
  assert.deepStrictEqual(
    withFixupOwnerTrailers([
      { sha: "owner", short: "owner", subject: "fix: owner", domain: "example", tier: "core" },
      { sha: "fixup", short: "fixup", subject: "fixup! fix: owner" },
      { sha: "orphan", short: "orphan", subject: "fixup! fix: missing" },
    ]).map(({ sha, domain, tier }) => ({ sha, domain, tier })),
    [
      { sha: "owner", domain: "example", tier: "core" },
      { sha: "fixup", domain: "example", tier: "core" },
      { sha: "orphan", domain: undefined, tier: undefined },
    ],
  );
});

it("guards every bounded commit without --replay-of", () => {
  const commits = [
    {
      sha: "abc1234",
      short: "abc1234",
      subject: "feat: thing",
      domain: "example",
      tier: "core",
    },
  ];
  const git = { run: (args: ReadonlyArray<string>) => (args[0] === "rev-list" ? "abc1234\n" : "") };
  assert.deepStrictEqual(
    resolveGuardedCommits(
      git,
      {
        base: null,
        head: "head",
        target: "target",
        typecheck: false,
        since: "since",
        replayOf: null,
      },
      { base: "base", head: "head", target: "target" },
      commits,
    ),
    commits,
  );
});
