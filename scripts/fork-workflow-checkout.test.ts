// Guards for checked-in hyprws workflows: checkout credential teardown and the
// pull-requests write permission PR-commenting workflows need.

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

const PULL_REQUEST_TRIGGER = /^on:\n(?:.*\n)*?  (?:pull_request_target|pull_request):/m;
const PR_COMMENT_ENDPOINT = /issues\/[^\s`"']*\/comments/;
const REFERENCED_SCRIPT = /scripts\/[\w./-]+\.ts/g;
const PULL_REQUESTS_WRITE = /^\s*pull-requests:\s*write\s*$/m;

// Workflows that trigger on pull requests and post PR comments (themselves or via
// scripts they run) must declare `pull-requests: write` even when they go through the
// issues comments endpoint; `issues: write` alone is 403 there on pull requests.
export const prCommentPermissionProblems = (
  path: string,
  workflow: string,
  scriptSource: (name: string) => string,
): ReadonlyArray<string> => {
  if (!PULL_REQUEST_TRIGGER.test(workflow)) return [];
  const scripts = [...new Set([...workflow.matchAll(REFERENCED_SCRIPT)].map((m) => m[0]))];
  const commentsOnPr =
    PR_COMMENT_ENDPOINT.test(workflow) ||
    scripts.some((name) => PR_COMMENT_ENDPOINT.test(scriptSource(name)));
  if (!commentsOnPr || PULL_REQUESTS_WRITE.test(workflow)) return [];
  return [
    `${path}: posts a pull-request comment but lacks \`pull-requests: write\` in its permissions block; add it (\`issues: write\` alone is 403 on pull requests).`,
  ];
};

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

it("rejects PR-commenting workflows without pull-requests: write", () => {
  const fixture = `on:
  pull_request_target:
permissions:
  contents: read
jobs:
  test:
    steps:
      - run: node scripts/post-comment.ts
`;
  assert.deepStrictEqual(
    prCommentPermissionProblems("fixture.yml", fixture, () => "gh api ... issues/${pr}/comments"),
    [
      "fixture.yml: posts a pull-request comment but lacks `pull-requests: write` in its permissions block; add it (`issues: write` alone is 403 on pull requests).",
    ],
  );
  assert.deepStrictEqual(
    prCommentPermissionProblems(
      "fixture.yml",
      fixture.replace("  contents: read\n", "  contents: read\n  pull-requests: write\n"),
      () => "",
    ),
    [],
  );
  assert.deepStrictEqual(
    prCommentPermissionProblems("fixture.yml", "on:\n  push:\n", () => "issues/1/comments"),
    [],
  );
});

it("accepts the live hyprws workflows for both guards", () => {
  const scriptDirectory = NodePath.join(import.meta.dirname, "..");
  const scriptSource = (name: string): string =>
    NodeFS.readFileSync(NodePath.join(scriptDirectory, name), "utf8");
  const problems = workflowFiles.flatMap((name) => {
    const source = NodeFS.readFileSync(NodePath.join(workflowDirectory, name), "utf8");
    return [
      ...checkoutCredentialProblems(`.github/workflows/${name}`, source),
      ...prCommentPermissionProblems(`.github/workflows/${name}`, source, scriptSource),
    ];
  });
  assert.deepStrictEqual(problems, []);
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
