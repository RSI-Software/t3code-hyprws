// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import { assert, it } from "@effect/vitest";

import {
  assessForkSupersedes,
  collectForkSupersedes,
  contradictingTitles,
  enclosedSupersededTitles,
  parseForkSupersedesCalls,
  testCaseTitles,
} from "./fork-supersedes.ts";

it("parses the three fields and the call line of a declaration", () => {
  const text = [
    `import { it } from "@effect/vitest";`,
    ``,
    `forkSupersedes({`,
    `  upstream: "apps/web/src/thing.test.ts > keeps the case",`,
    `  reason: "the fork inverts the behaviour",`,
    `  commit: "abc1234",`,
    `});`,
  ].join("\n");
  const [call] = parseForkSupersedesCalls(text);
  assert.equal(call?.line, 3);
  assert.equal(call?.upstream, "apps/web/src/thing.test.ts > keeps the case");
  assert.equal(call?.reason, "the fork inverts the behaviour");
  assert.equal(call?.commit, "abc1234");
});

it("refuses a declaration missing a field or carrying a malformed upstream ref", () => {
  const missing = `forkSupersedes({ upstream: "a.test.ts > t", reason: "why" });`;
  const missingResult = collectForkSupersedes(missing);
  assert.isEmpty(missingResult.declarations);
  assert.match(missingResult.refusals[0]?.detail ?? "", /missing commit/);

  const bare = `forkSupersedes({ upstream: "a.test.ts", reason: "why", commit: "abc" });`;
  const bareResult = collectForkSupersedes(bare);
  assert.isEmpty(bareResult.declarations);
  assert.match(bareResult.refusals[0]?.detail ?? "", /"<upstream path> > <test name>"/);

  const good = `forkSupersedes({ upstream: "a.test.ts > t", reason: "why", commit: "abc" });`;
  const goodResult = collectForkSupersedes(good);
  assert.isEmpty(goodResult.refusals);
  assert.deepStrictEqual(goodResult.declarations[0], {
    upstreamPath: "a.test.ts",
    upstreamTitle: "t",
    reason: "why",
    commit: "abc",
    line: 1,
  });
});

it("resolves a declaration before its case, and none after the last opener", () => {
  // The CodexAdapter shape: a declaration with a comment above it sits
  // immediately before the case it documents, with no case opener before
  // it. At-or-after resolution excuses it; a declaration after the last
  // opener excuses nothing (RSI-Software/t3code-hyprws#1208).
  const decl =
    'forkSupersedes({ upstream: "apps/server/src/provider/Layers/CodexAdapter.test.ts > maps codex model options before starting a session", reason: "the fork splits identity from launch options", commit: "afe622b5dc" });';
  const before = [
    "// Moved from the upstream file: the runtime options are asserted as identity.",
    decl,
    'it.effect("maps codex model options before starting a session", () => {});',
    "",
  ].join("\n");
  assert.deepStrictEqual(
    enclosedSupersededTitles(before, "apps/server/src/provider/Layers/CodexAdapter.test.ts"),
    ["maps codex model options before starting a session"],
  );
  const after = [
    'it.effect("maps codex model options before starting a session", () => {});',
    decl,
    "",
  ].join("\n");
  assert.isEmpty(
    enclosedSupersededTitles(after, "apps/server/src/provider/Layers/CodexAdapter.test.ts"),
  );
});

it("ignores a forkSupersedes-shaped mention that is not a call", () => {
  const prose = `// forkSupersedes({ upstream, reason, commit }) is the declaration form`;
  assert.isEmpty(parseForkSupersedesCalls(prose));
  assert.isEmpty(collectForkSupersedes(prose).refusals);
});

it("reads case titles across the dotted effect forms", () => {
  const text = [
    `it("plain", () => {});`,
    `it.effect("dotted", () => {});`,
    `test.skip("skipped", () => {});`,
    `describe("a suite", () => {});`,
  ].join("\n");
  assert.deepStrictEqual(testCaseTitles(text), ["plain", "dotted", "skipped"]);
});

it("refuses a declaration naming an absent file or title", () => {
  const sibling = `forkSupersedes({ upstream: "gone.test.ts > t", reason: "why", commit: "abc" });`;
  const absent = assessForkSupersedes(new Map([["a.fork.test.ts", sibling]]), new Map(), new Map());
  assert.match(absent.refusals.join("\n"), /does not carry/);
  assert.isEmpty(absent.superseded);

  const renamed = assessForkSupersedes(
    new Map([["a.fork.test.ts", sibling.replace("gone.test.ts", "here.test.ts")]]),
    new Map([["here.test.ts", `it("other", () => {});`]]),
    new Map(),
  );
  assert.match(renamed.refusals.join("\n"), /renamed or removed/);
  assert.isEmpty(renamed.superseded);
});

it("treats a declared contradiction as superseded and an undeclared one as a finding", () => {
  const upstream = `it("keeps the case", () => { expect(1).toBe(1); });`;
  const texts = new Map([["thing.test.ts", upstream]]);
  const declared = assessForkSupersedes(
    new Map([
      [
        "thing.fork.test.ts",
        [
          `forkSupersedes({ upstream: "thing.test.ts > keeps the case", reason: "why", commit: "abc" });`,
          `it("keeps the case", () => { expect(1).toBe(2); });`,
        ].join("\n"),
      ],
    ]),
    texts,
    new Map(),
  );
  assert.isEmpty(declared.refusals);
  assert.isEmpty(declared.undeclared);
  assert.deepStrictEqual(declared.superseded, [{ path: "thing.test.ts", title: "keeps the case" }]);

  const bare = assessForkSupersedes(
    new Map([["thing.fork.test.ts", `it("keeps the case", () => { expect(1).toBe(2); });`]]),
    texts,
    new Map(),
  );
  assert.deepStrictEqual(bare.undeclared, [
    { sibling: "thing.fork.test.ts", title: "keeps the case" },
  ]);
  assert.deepStrictEqual(
    contradictingTitles(["keeps the case", "fork only"], new Set(["keeps the case"]), new Set()),
    ["keeps the case"],
  );
});

it("refuses a declaration whose upstream case body now matches the fork", () => {
  // Gap 3: the upstream case was validated on title alone, so rewriting
  // its body into agreement with the fork still read as a live
  // divergence (RSI-Software/t3code-hyprws#1206). Fixture strings only:
  // RSI-Software/t3code-hyprws#1204 removed the live rename instance.
  const upstream = [
    `it("other", () => {`,
    `  expect(0).toBe(0);`,
    `});`,
    `it("keeps the case", () => {`,
    `  expect(1).toBe(2);`,
    `});`,
  ].join("\n");
  const agreed = [
    `forkSupersedes({ upstream: "thing.test.ts > keeps the case", reason: "why", commit: "abc" });`,
    `it("keeps the case", () => {`,
    `  expect(1).toBe(2);`,
    `});`,
  ].join("\n");
  const stale = assessForkSupersedes(
    new Map([["thing.fork.test.ts", agreed]]),
    new Map([["thing.test.ts", upstream]]),
    new Map(),
  );
  assert.isEmpty(stale.refusals);
  assert.isEmpty(stale.superseded);
  assert.lengthOf(stale.retireCandidates, 1);
  assert.equal(stale.retireCandidates[0]?.sibling, "thing.fork.test.ts");

  const diverged = assessForkSupersedes(
    new Map([["thing.fork.test.ts", agreed.replace("expect(1).toBe(2);", "expect(1).toBe(3);")]]),
    new Map([["thing.test.ts", upstream]]),
    new Map(),
  );
  assert.isEmpty(diverged.refusals);
  assert.deepStrictEqual(diverged.superseded, [{ path: "thing.test.ts", title: "keeps the case" }]);
});

it("reports an in-place rename the sibling copied", () => {
  // Gap 1 in the issue's own words: undeclared detection is blind to
  // a rename — it fires only when a sibling case shares a title with
  // its upstream counterpart, so a fork that renames upstream's case in
  // place and copies the result to the sibling leaves no shared title
  // and reports nothing — the damaging shape, because it mutates the
  // upstream file (RSI-Software/t3code-hyprws#1206). Fixture strings
  // only: RSI-Software/t3code-hyprws#1204 removed the live rename
  // instance. The sibling predates the head's rename: it carries the
  // base body under the base title, so head and sibling share no
  // renamed title and the old title-sharing rule reports nothing.
  const base = [
    `it("replaces the standalone explorer", () => {`,
    `  expect(1).toBe(1);`,
    `});`,
    `it("stays put", () => {`,
    `  expect(0).toBe(0);`,
    `});`,
  ].join("\n");
  const head = [
    `it("keeps the standalone explorer", () => {`,
    `  expect(1).toBe(1);`,
    `});`,
    `it("stays put", () => {`,
    `  expect(0).toBe(0);`,
    `});`,
  ].join("\n");
  const sibling = [
    `it("replaces the standalone explorer", () => {`,
    `  expect(1).toBe(1);`,
    `});`,
  ].join("\n");
  // The head renamed the case in place; the sibling still carries the
  // base body under the base title the head dropped. The old detector
  // sees no shared title and stays silent; the base comparison reports
  // the copied rename.
  const found = assessForkSupersedes(
    new Map([["thing.fork.test.ts", sibling]]),
    new Map([["thing.test.ts", head]]),
    new Map([["thing.test.ts", base]]),
  );
  assert.deepStrictEqual(found.undeclared, [
    { sibling: "thing.fork.test.ts", title: "replaces the standalone explorer" },
  ]);

  // A sibling case unrelated to the rename stays silent: its title is
  // new since the base but its body matches no dropped base case.
  const quiet = assessForkSupersedes(
    new Map([["thing.fork.test.ts", `it("fork only", () => { expect(0).toBe(0); });`]]),
    new Map([["thing.test.ts", head]]),
    new Map([["thing.test.ts", base]]),
  );
  assert.isEmpty(quiet.undeclared);

  // Against the base tree the old rule still reports by shared title —
  // the rename check only adds the in-place upstream mutation the old
  // rule cannot see.
  const blind = assessForkSupersedes(
    new Map([["thing.fork.test.ts", sibling]]),
    new Map([["thing.test.ts", base]]),
    new Map([["thing.test.ts", base]]),
  );
  assert.deepStrictEqual(blind.undeclared, [
    { sibling: "thing.fork.test.ts", title: "replaces the standalone explorer" },
  ]);
});

it("judges retire per declared case, not per sibling file", () => {
  // Gap 2: retire candidacy read the whole sibling file inside the
  // per-declaration loop, so two declarations with one adopted retired
  // neither, and a sibling that is a subset of the upstream file retired
  // all (RSI-Software/t3code-hyprws#1206). Fixture strings only:
  // RSI-Software/t3code-hyprws#1204 removed the live rename instance.
  const upstream = [
    `it("first", () => {`,
    `  expect(1).toBe(2);`,
    `});`,
    `it("second", () => {`,
    `  expect(1).toBe(2);`,
    `});`,
    `it("third", () => {`,
    `  expect(9).toBe(9);`,
    `});`,
  ].join("\n");
  const sibling = [
    `forkSupersedes({ upstream: "thing.test.ts > first", reason: "why", commit: "abc" });`,
    `it("first", () => {`,
    `  expect(1).toBe(2);`,
    `});`,
    `forkSupersedes({ upstream: "thing.test.ts > second", reason: "why", commit: "abc" });`,
    `it("second", () => {`,
    `  expect(9).toBe(9);`,
    `});`,
  ].join("\n");
  const result = assessForkSupersedes(
    new Map([["thing.fork.test.ts", sibling]]),
    new Map([["thing.test.ts", upstream]]),
    new Map(),
  );
  assert.isEmpty(result.refusals);
  assert.deepStrictEqual(result.superseded, [{ path: "thing.test.ts", title: "second" }]);
  assert.deepStrictEqual(
    result.retireCandidates.map((candidate) => candidate.upstreamTitle),
    ["first"],
  );
});
