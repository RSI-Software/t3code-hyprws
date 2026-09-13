// @effect-diagnostics nodeBuiltinImport:off - reads checked-in workflow files.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const CHECKOUT_STEP = /^\s*uses:\s*actions\/checkout@/m;
const STEP = /^(\s*)-\s+(?=\S)/gm;

const steps = (workflow: string): ReadonlyArray<string> => {
  const starts = [...workflow.matchAll(STEP)].map((match) => match.index ?? 0);
  return starts.map((start, index) => workflow.slice(start, starts[index + 1]));
};

export const checkoutCredentialProblems = (path: string, workflow: string): ReadonlyArray<string> =>
  steps(workflow).flatMap((step, index) =>
    CHECKOUT_STEP.test(step) && /^\s+persist-credentials:\s*false\s*(?:#.*)?$/m.test(step)
      ? [
          `${path} checkout step ${index + 1}: fork-workflow-checkout guard forbids persist-credentials: false; use hyprws-upstream-sync.yml's token scrub when credentials must not persist.`,
        ]
      : [],
  );

const workflowDirectory = NodePath.join(import.meta.dirname, "../.github/workflows");
const workflowFiles = NodeFS.readdirSync(workflowDirectory)
  .filter((name) => /^hyprws-.*\.yml$/.test(name))
  .toSorted();

it("rejects persisted-credential teardown in every checkout step", () => {
  const fixture = `jobs:
  test:
    steps:
      - name: First checkout
        uses: actions/checkout@v6
      - name: Unsafe checkout
        uses: actions/checkout@v6
        with:
          persist-credentials: false
`;
  assert.deepStrictEqual(checkoutCredentialProblems("fixture.yml", fixture), [
    "fixture.yml checkout step 2: fork-workflow-checkout guard forbids persist-credentials: false; use hyprws-upstream-sync.yml's token scrub when credentials must not persist.",
  ]);
});

it("accepts the live hyprws workflow checkouts", () => {
  const problems = workflowFiles.flatMap((name) =>
    checkoutCredentialProblems(
      `.github/workflows/${name}`,
      NodeFS.readFileSync(NodePath.join(workflowDirectory, name), "utf8"),
    ),
  );
  assert.deepStrictEqual(problems, []);
});
