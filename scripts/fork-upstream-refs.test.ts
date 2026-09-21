import { assert, it } from "@effect/vitest";

import { findUpstreamReferences, renderReferences } from "./fork-upstream-refs.ts";

const lines = (...input: ReadonlyArray<string>) => input.join("\n");

const texts = (body: string) => findUpstreamReferences(body).map((reference) => reference.text);

it("fails a bare upstream number outside a code span or fence", () => {
  const references = findUpstreamReferences(
    lines("Upstream context.", "", "The regression landed in #4379 last week."),
  );
  assert.deepStrictEqual(references, [
    {
      kind: "number",
      text: "#4379",
      line: 3,
      column: 26,
    },
  ]);
  assert.strictEqual(
    renderReferences(references),
    "3:26 #4379 (bare item number, resolved upstream when this fork has no such item)\n",
  );
});

it("passes the item in a code span and the fork item in full form", () => {
  assert.deepStrictEqual(
    texts("Cite `pingdotgg/t3code#4379`, not RSI-Software/t3code-hyprws#108."),
    [],
  );
});

it("passes a pasted survey inside one fenced block", () => {
  assert.deepStrictEqual(
    texts(
      lines(
        "The upstream survey:",
        "",
        "```text",
        "pingdotgg/t3code#4379 files explorer tab",
        "```",
        "",
        "It is already carried here.",
      ),
    ),
    [],
  );
});

it("fails a cross-repo reference and an upstream item URL", () => {
  assert.deepStrictEqual(
    texts("pingdotgg/t3code#4379 and github.com/pingdotgg/t3code/issues/4402 are live."),
    ["pingdotgg/t3code#4379", "github.com/pingdotgg/t3code/issues/4402"],
  );
});
