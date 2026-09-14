import * as NodeAssert from "node:assert/strict";

import { it } from "vite-plus/test";

import {
  FORK_LOG_FIELD_SEPARATOR,
  FORK_LOG_RECORD_SEPARATOR,
  forkLogArguments,
  parseForkLog,
  parseForkTrailers,
} from "./fork-trailers.ts";

const trailerBlock = [
  "Fork-Domain: fork-meta",
  "Fork-Tier: bugfix",
  "Fork-Upstreamable: no",
  "Fork-Wire: reviewed #1",
  "Fork-Repair: none",
].join("\n");

it("one trailer per key parses unchanged", () => {
  const parsed = parseForkTrailers(trailerBlock);
  NodeAssert.deepEqual(parsed, {
    domain: "fork-meta",
    tier: "bugfix",
    upstreamable: "no",
    wireReviewed: "reviewed #1",
    repair: "none",
  });
});

it("two identical copies parse to that value without throwing", () => {
  const parsed = parseForkTrailers(`${trailerBlock}\nFork-Domain: fork-meta`);
  NodeAssert.equal(parsed.domain, "fork-meta");
});

it("five identical copies (the 8778853f80 shape) do not throw", () => {
  const body = [
    trailerBlock,
    "Fork-Domain: fork-meta",
    "Fork-Domain: fork-meta",
    "Fork-Domain: fork-meta",
    "Fork-Domain: fork-meta",
  ].join("\n");
  NodeAssert.equal(parseForkTrailers(body).domain, "fork-meta");
});

it("two disagreeing copies throw naming both values in message order", () => {
  NodeAssert.throws(
    () => parseForkTrailers(`${trailerBlock}\nFork-Domain: worktrunk-hooks`),
    (error: Error) => {
      const message = error.message;
      NodeAssert.match(message, /Fork-Domain/);
      const first = message.indexOf("fork-meta");
      const second = message.indexOf("worktrunk-hooks");
      NodeAssert.ok(first !== -1 && second !== -1, message);
      NodeAssert.ok(first < second, `values not in message order: ${message}`);
      return true;
    },
  );
});

for (const [key, first, second] of [
  ["Fork-Domain", "fork-meta", "worktrunk-hooks"],
  ["Fork-Tier", "bugfix", "feature"],
  ["Fork-Upstreamable", "no", "yes"],
  ["Fork-Wire", "reviewed #1", "reviewed #2"],
  ["Fork-Repair", "none", "replayed"],
] as const) {
  it(`disagreement in ${key} throws naming both values`, () => {
    const body = `${trailerBlock}\n${key}: ${first}\n${key}: ${second}`;
    NodeAssert.throws(
      () => parseForkTrailers(body),
      (error: Error) => {
        const firstAt = error.message.indexOf(first);
        const secondAt = error.message.indexOf(second);
        NodeAssert.ok(firstAt !== -1 && secondAt !== -1, error.message);
        NodeAssert.ok(firstAt < secondAt, `values not in message order: ${error.message}`);
        return true;
      },
    );
  });
}

it("an empty copy invalidates the block shape, so the body has no trailers", () => {
  // `Fork-Domain:` with no value is not a `Key: value` line, so the final paragraph is no longer
  // a pure trailer block under the reader's rule; the body parses to no trailers and the caller's
  // missing-trailer refusal names it instead of a duplicate-disagreement throw.
  const body = `${trailerBlock}\nFork-Domain:\nFork-Domain: fork-meta`;
  NodeAssert.deepEqual(parseForkTrailers(body), {});
});

it("case-insensitive key matching still applies, including across duplicates", () => {
  const parsed = parseForkTrailers(`${trailerBlock}\nfork-domain: fork-meta`);
  NodeAssert.equal(parsed.domain, "fork-meta");
});

it("a disagreeing duplicate in parseForkLog names the commit", () => {
  const record = [
    "abc1234",
    "abc1234",
    "2026-09-09T14:28:59+12:00",
    "some subject",
    `${trailerBlock}\nFork-Tier: feature`,
  ].join(FORK_LOG_FIELD_SEPARATOR);
  NodeAssert.throws(
    () => parseForkLog(`${record}${FORK_LOG_RECORD_SEPARATOR}`),
    (error: Error) => {
      NodeAssert.match(error.message, /abc1234 some subject:/);
      NodeAssert.match(error.message, /Fork-Tier/);
      return true;
    },
  );
});

it("a colon-bearing prose line is not read as a trailer", () => {
  const body = ["Note: this prose mentions Fork-Domain in passing.", "", trailerBlock].join("\n");
  const parsed = parseForkTrailers(body);
  NodeAssert.equal(parsed.domain, "fork-meta");
});

it("a prose paragraph that names fork trailers above a real block is not read as a trailer (1c2f9d5628)", () => {
  const body = [
    "## Tier decision",
    "Fork-Tier: bugfix, Fork-Upstreamable: yes — after the fold, the composer refocus predicate",
    "is shared with the window-focus path.",
    "",
    "Fork-Domain: upstream-fixes",
    "Fork-Tier: bugfix",
    "Fork-Upstreamable: yes",
    "Co-authored-by: donjor-agent[bot] <agent@example.com>",
  ].join("\n");
  const parsed = parseForkTrailers(body);
  NodeAssert.deepEqual(parsed, { domain: "upstream-fixes", tier: "bugfix", upstreamable: "yes" });
});

it("a body whose only fork trailer sits in prose has no trailers", () => {
  const body = "The gate reads Fork-Tier: bugfix from the paragraph above.\n\nCloses #19.\n";
  NodeAssert.deepEqual(parseForkTrailers(body), {});
});

it("a cherry-pick line inside the block does not hide it (c324f9bab0)", () => {
  const body = [
    "Fork-Domain: worktrunk-hooks",
    "Fork-Tier: core",
    "Fork-Wire: reviewed fork-local alias removed; wire slots and literals unchanged",
    "Co-authored-by: donjor <38745786+donjor@users.noreply.github.com>",
    "(cherry picked from commit 042c93b823229dca8aeb587d8dd8e3c72ac5123d)",
  ].join("\n");
  const parsed = parseForkTrailers(body);
  NodeAssert.equal(parsed.domain, "worktrunk-hooks");
  NodeAssert.equal(parsed.tier, "core");
});

it("a dash separator paragraph and co-author below the block do not hide it (8778853f80)", () => {
  const body = [
    trailerBlock,
    "",
    "---------",
    "",
    "Co-authored-by: donjor <donjordev@gmail.com>",
  ].join("\n");
  NodeAssert.equal(parseForkTrailers(body).domain, "fork-meta");
});

it("a Closes reference paragraph and co-author below the block do not hide it (47852a62a9)", () => {
  const body = [
    trailerBlock,
    "",
    "Closes RSI-Software/t3code-hyprws#920",
    "",
    "Co-authored-by: donjor <38745786+donjor@users.noreply.github.com>",
  ].join("\n");
  NodeAssert.equal(parseForkTrailers(body).domain, "fork-meta");
});

it("a trailing comment paragraph and co-author line do not hide the real block (134a11855d)", () => {
  const body = [
    trailerBlock,
    "",
    '<!-- gh-bot:stack {"v":1,"parent":610,"root":"hyprws"} -->',
    "",
    "Co-authored-by: donjor <38745786+donjor@users.noreply.github.com>",
    "",
  ].join("\n");
  NodeAssert.deepEqual(parseForkTrailers(body), {
    domain: "fork-meta",
    tier: "bugfix",
    upstreamable: "no",
    wireReviewed: "reviewed #1",
    repair: "none",
  });
});

it("two disagreeing fork trailers inside one block still throw, even with tail material below", () => {
  const body = [
    trailerBlock,
    "Fork-Tier: feature",
    "",
    "Co-authored-by: donjor <donjordev@gmail.com>",
  ].join("\n");
  NodeAssert.throws(() => parseForkTrailers(body), /Fork-Tier/);
});

it("forkLogArguments still targets base..head", () => {
  const args = forkLogArguments("base", "head");
  NodeAssert.ok(args.includes("base..head"));
});
