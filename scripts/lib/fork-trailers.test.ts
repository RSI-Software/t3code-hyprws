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

it("an empty copy next to a valued copy throws, naming the empty copy legibly", () => {
  const body = `${trailerBlock}\nFork-Domain:\nFork-Domain: fork-meta`;
  NodeAssert.throws(
    () => parseForkTrailers(body),
    (error: Error) => {
      NodeAssert.match(error.message, /Fork-Domain/);
      // First occurrence in the body is the valued copy, so it comes first in the message.
      NodeAssert.match(error.message, /"fork-meta", \(empty\)/);
      return true;
    },
  );
});

it("case-insensitive key matching still applies, including across duplicates", () => {
  const parsed = parseForkTrailers(`${trailerBlock}\nfork-domain: fork-meta`);
  NodeAssert.equal(parsed.domain, "fork-meta");
});

it("a disagreeing duplicate in parseForkLog names the commit", () => {
  const record = ["abc1234", "abc1234", "some subject", `${trailerBlock}\nFork-Tier: feature`].join(
    FORK_LOG_FIELD_SEPARATOR,
  );
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
  // And a prose line after the trailer block does not override it.
  const withTrailingProse = `${trailerBlock}\n\nWarning: Fork-Domain may be absent.`;
  NodeAssert.equal(parseForkTrailers(withTrailingProse).domain, "fork-meta");
});

it("forkLogArguments still targets base..head", () => {
  const args = forkLogArguments("base", "head");
  NodeAssert.ok(args.includes("base..head"));
});
