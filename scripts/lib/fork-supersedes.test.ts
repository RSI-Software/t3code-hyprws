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
  const absent = assessForkSupersedes(new Map([["a.fork.test.ts", sibling]]), new Map());
  assert.match(absent.refusals.join("\n"), /does not carry/);
  assert.isEmpty(absent.superseded);

  const renamed = assessForkSupersedes(
    new Map([["a.fork.test.ts", sibling.replace("gone.test.ts", "here.test.ts")]]),
    new Map([["here.test.ts", `it("other", () => {});`]]),
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
  );
  assert.isEmpty(declared.refusals);
  assert.isEmpty(declared.undeclared);
  assert.deepStrictEqual(declared.superseded, [{ path: "thing.test.ts", title: "keeps the case" }]);

  const bare = assessForkSupersedes(
    new Map([["thing.fork.test.ts", `it("keeps the case", () => { expect(1).toBe(2); });`]]),
    texts,
  );
  assert.deepStrictEqual(bare.undeclared, [
    { sibling: "thing.fork.test.ts", title: "keeps the case" },
  ]);
  assert.deepStrictEqual(
    contradictingTitles(["keeps the case", "fork only"], new Set(["keeps the case"]), new Set()),
    ["keeps the case"],
  );
});

it("names a declaration whose upstream case adopted the behaviour as a retire candidate", () => {
  const upstream = [`it("keeps the case", () => {`, `  expect(1).toBe(2);`, `});`].join("\n");
  const sibling = [
    `forkSupersedes({ upstream: "thing.test.ts > keeps the case", reason: "why", commit: "abc" });`,
    `it("keeps the case", () => {`,
    `  expect(1).toBe(2);`,
    `});`,
  ].join("\n");
  const adopted = assessForkSupersedes(
    new Map([["thing.fork.test.ts", sibling]]),
    new Map([["thing.test.ts", upstream]]),
  );
  assert.isEmpty(adopted.refusals);
  assert.lengthOf(adopted.retireCandidates, 1);
  assert.equal(adopted.retireCandidates[0]?.sibling, "thing.fork.test.ts");

  const diverged = assessForkSupersedes(
    new Map([[`thing.fork.test.ts`, `${sibling}\n  expect(2).toBe(3);`]]),
    new Map([["thing.test.ts", upstream]]),
  );
  assert.isEmpty(diverged.retireCandidates);
});
