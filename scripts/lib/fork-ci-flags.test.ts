// @effect-diagnostics nodeBuiltinImport:off - Flag derivation is Git plumbing; fixtures need real repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

import {
  deriveForkCiFlags,
  forkCiWorkflowDriftProblem,
  forkScanArguments,
  FORK_CI_FLAGS_SCRIPT,
  FORK_CI_OUTPUT_KEYS,
  FORK_CI_WORKFLOW_PATH,
  renderForkCiOutputs,
  renderForkCiScanArguments,
  systemForkCiGit,
  type ForkCiGit,
} from "./fork-ci-flags.ts";
import { SystemGit } from "./fork-command.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const BASE = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const TRUNK = "cccc3333cccc3333cccc3333cccc3333cccc3333";
const HEAD_PARENT = "dddd4444dddd4444dddd4444dddd4444dddd4444";

const fakeGit = (overrides: {
  readonly base?: string;
  readonly trunkMergeBase?: string | null;
  readonly trunkResolves?: boolean;
}): ForkCiGit => ({
  run: (args) => {
    if (args[0] === "merge-base" && args[1] === "upstream/main")
      return `${overrides.base ?? BASE}\n`;
    if (args[0] === "rev-parse") return `${HEAD}\n`;
    throw new Error(`unexpected required git call: ${args.join(" ")}`);
  },
  attempt: (args) => {
    if (args[0] === "merge-base")
      return overrides.trunkMergeBase === undefined ? `${TRUNK}\n` : overrides.trunkMergeBase;
    if (args[0] === "rev-parse") return overrides.trunkResolves === false ? null : `${TRUNK}\n`;
    return null;
  },
});

it("derives base, since, target, and replay-of the way the workflow used to", () => {
  assert.deepStrictEqual(deriveForkCiFlags(fakeGit({}), HEAD), {
    head: HEAD,
    base: BASE,
    since: TRUNK,
    target: BASE,
    replayOf: "origin/hyprws",
  });
});

it("falls back to head^ when the head is the trunk tip itself", () => {
  const flags = deriveForkCiFlags(fakeGit({ trunkMergeBase: `${HEAD}\n` }), HEAD);
  assert.strictEqual(flags.since, `${HEAD}^`);
});

it("falls back to head^ and drops replay-of when the trunk ref is absent", () => {
  const flags = deriveForkCiFlags(fakeGit({ trunkMergeBase: null, trunkResolves: false }), HEAD);
  assert.strictEqual(flags.since, `${HEAD}^`);
  assert.strictEqual(flags.replayOf, null);
});

it("passes the whole CI shape to fork:scan, replay-of included only when it resolves", () => {
  const flags = deriveForkCiFlags(fakeGit({}), HEAD);
  assert.deepStrictEqual(forkScanArguments(flags), [
    "--head",
    HEAD,
    "--target",
    BASE,
    "--since",
    TRUNK,
    "--replay-of",
    "origin/hyprws",
    "--no-typecheck",
  ]);
  const offTrunk = deriveForkCiFlags(fakeGit({ trunkResolves: false, trunkMergeBase: null }), HEAD);
  assert.deepStrictEqual(forkScanArguments(offTrunk), [
    "--head",
    HEAD,
    "--target",
    BASE,
    "--since",
    `${HEAD}^`,
    "--no-typecheck",
  ]);
});

it("renders the GitHub output keys the workflow consumes, empty replay-of included", () => {
  assert.deepStrictEqual(
    [...FORK_CI_OUTPUT_KEYS],
    ["head", "base", "since", "target", "replay-of"],
  );
  assert.strictEqual(
    renderForkCiOutputs(deriveForkCiFlags(fakeGit({}), HEAD)),
    `head=${HEAD}\nbase=${BASE}\nsince=${TRUNK}\ntarget=${BASE}\nreplay-of=origin/hyprws\n`,
  );
  assert.strictEqual(
    renderForkCiOutputs(
      deriveForkCiFlags(fakeGit({ trunkResolves: false, trunkMergeBase: null }), HEAD),
    ),
    `head=${HEAD}\nbase=${BASE}\nsince=${HEAD}^\ntarget=${BASE}\nreplay-of=\n`,
  );
});

it("renders the scan argv one token per line for the workflow's mapfile", () => {
  assert.strictEqual(
    renderForkCiScanArguments(deriveForkCiFlags(fakeGit({}), HEAD)),
    `--head\n${HEAD}\n--target\n${BASE}\n--since\n${TRUNK}\n--replay-of\norigin/hyprws\n--no-typecheck\n`,
  );
});

const repository = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ci-flags-test-"));
  const git = (args: ReadonlyArray<string>): void => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`);
  };
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.email", "fork@example.invalid"]);
  git(["config", "user.name", "fork"]);
  NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "upstream base"]);
  git(["update-ref", "refs/remotes/upstream/main", "main"]);
  git(["branch", "trunk"]);
  NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fork commit", "-m", "Fork-Domain: fork-meta"]);
  return root;
};

it("derives the same flags from a real repository with remote-tracking refs", () => {
  const root = repository();
  try {
    const git = systemForkCiGit(new SystemGit(root));
    const reader = new SystemGit(root);
    const head = reader.run(["rev-parse", "HEAD"]).trim();
    const base = reader.run(["rev-parse", "trunk"]).trim();
    // No origin/hyprws ref yet: since falls back to head^ and replay-of is absent.
    assert.deepStrictEqual(deriveForkCiFlags(git, head), {
      head,
      base,
      since: `${head}^`,
      target: base,
      replayOf: null,
    });
    reader.run(["update-ref", "refs/remotes/origin/hyprws", "main"]);
    // The head sits on the trunk tip: still head^, but the trunk now resolves.
    assert.deepStrictEqual(deriveForkCiFlags(git, head), {
      head,
      base,
      since: `${head}^`,
      target: base,
      replayOf: "origin/hyprws",
    });
    reader.run(["update-ref", "refs/remotes/origin/hyprws", "trunk"]);
    // One fork commit above the trunk: the trunk commit is the since.
    assert.deepStrictEqual(deriveForkCiFlags(git, head), {
      head,
      base,
      since: base,
      target: base,
      replayOf: "origin/hyprws",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const workflow = (ledgerRun: string, scanRun: string): string => `jobs:
  check:
    steps:
      - name: Fork ledger
        id: fork_ledger
        env:
          HEAD_SHA: \${{ github.sha }}
        run: |
${ledgerRun}
      - name: Fork rebase scan
        env:
          HEAD_SHA: \${{ github.sha }}
        run: |
${scanRun}
`;

const goodLedgerRun = [
  "          git remote add upstream https://github.com/pingdotgg/t3code.git",
  "          git fetch --no-tags upstream main",
  `          vp run fork:delta --check --head "$HEAD_SHA"`,
  `          node ${FORK_CI_FLAGS_SCRIPT} ledger --head "$HEAD_SHA" >> "$GITHUB_OUTPUT"`,
].join("\n");
const goodScanRun = [
  `          mapfile -t SCAN_ARGS < <(node ${FORK_CI_FLAGS_SCRIPT} scan --head "$HEAD_SHA")`,
  '          vp run fork:scan "${SCAN_ARGS[@]}"',
].join("\n");

it("accepts the workflow when both steps replay the helper", () => {
  assert.strictEqual(forkCiWorkflowDriftProblem(workflow(goodLedgerRun, goodScanRun)), undefined);
});

it("reports a missing workflow", () => {
  assert.include(forkCiWorkflowDriftProblem(undefined) ?? "", "is missing");
});

it("reports a ledger step that derives the flags by hand", () => {
  const restated = goodLedgerRun.replace(
    `node ${FORK_CI_FLAGS_SCRIPT} ledger --head "$HEAD_SHA" >> "$GITHUB_OUTPUT"`,
    'BASE=$(git merge-base upstream/main "$HEAD_SHA")',
  );
  assert.include(
    forkCiWorkflowDriftProblem(workflow(restated, goodScanRun)) ?? "",
    FORK_CI_FLAGS_SCRIPT,
  );
  const noHelper = goodLedgerRun
    .split("\n")
    .filter((line) => !line.includes(`${FORK_CI_FLAGS_SCRIPT} ledger`))
    .join("\n");
  assert.include(
    forkCiWorkflowDriftProblem(workflow(noHelper, goodScanRun)) ?? "",
    "must derive the flags",
  );
});

it("reports a scan step that assembles its flags by hand", () => {
  const handBuilt = [
    '          args=(--head "$HEAD_SHA" --target "$BASE" --since "$SINCE" --no-typecheck)',
    "          if git rev-parse --verify --quiet origin/hyprws >/dev/null; then",
    "            args+=(--replay-of origin/hyprws)",
    "          fi",
    '          vp run fork:scan "${args[@]}"',
  ].join("\n");
  assert.include(
    forkCiWorkflowDriftProblem(workflow(goodLedgerRun, handBuilt)) ?? "",
    "must build its argv",
  );
  const partial = goodScanRun.replace(
    'vp run fork:scan "${SCAN_ARGS[@]}"',
    'vp run fork:scan --head "$HEAD_SHA"',
  );
  assert.include(forkCiWorkflowDriftProblem(workflow(goodLedgerRun, partial)) ?? "", "must run");
});

it("accepts the real workflow", () => {
  const real = NodeFS.readFileSync(NodePath.join(repoRoot, FORK_CI_WORKFLOW_PATH), "utf8");
  assert.strictEqual(forkCiWorkflowDriftProblem(real), undefined);
});
