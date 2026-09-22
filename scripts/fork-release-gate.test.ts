import { assert, it } from "@effect/vitest";

import { decideReleaseGate, parseReleaseGateOptions, renderGateOutput } from "./fork-release-gate.ts";

const sha = (prefix: string): string => `${prefix}${"0".repeat(40 - prefix.length)}`;

it("opens the gate only for the trunk tip with green hyprws CI", () => {
  const tip = sha("abc");
  assert.deepStrictEqual(decideReleaseGate({ releaseSha: tip, trunkTip: tip, ciConclusion: "success" }), {
    proceed: true,
    reason: `release gate open: ${tip.slice(0, 12)} is the hyprws tip with green hyprws CI`,
  });
});

it("closes the gate for a green sha that is no longer the trunk tip", () => {
  const decision = decideReleaseGate({
    releaseSha: sha("abc"),
    trunkTip: sha("def"),
    ciConclusion: "success",
  });
  assert.strictEqual(decision.proceed, false);
  assert.match(decision.reason, /not the hyprws tip/);
  assert.match(decision.reason, /not what the lease push landed/);
});

it("closes the gate for a trunk tip whose battery never ran", () => {
  const tip = sha("abc");
  for (const ciConclusion of [null, "", "failure", "cancelled", "stale"]) {
    const decision = decideReleaseGate({ releaseSha: tip, trunkTip: tip, ciConclusion });
    assert.strictEqual(decision.proceed, false, String(ciConclusion));
    assert.match(decision.reason, /release gate closed/);
  }
});

it("closes the gate when a sha is missing and compares case-insensitively", () => {
  assert.strictEqual(
    decideReleaseGate({ releaseSha: "", trunkTip: sha("abc"), ciConclusion: "success" }).proceed,
    false,
  );
  const tip = sha("abc");
  assert.strictEqual(
    decideReleaseGate({ releaseSha: tip.toUpperCase(), trunkTip: tip, ciConclusion: "SUCCESS" })
      .proceed,
    true,
  );
});

it("renders the github output the workflow consumes", () => {
  const output = renderGateOutput({ proceed: false, reason: "release gate closed: x" });
  assert.match(output, /^gate_proceed=false$/m);
  assert.match(output, /^gate_reason=release gate closed: x$/m);
  assert.throws(() => parseReleaseGateOptions(["--release-sha", sha("abc")]), /--trunk-tip/);
});
