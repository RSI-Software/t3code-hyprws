import { assert, it } from "@effect/vitest";

import { deriveCiTestJobs, shellWords } from "./fork-ci-jobs.ts";

const workflow = (jobs: string): string => `name: hyprws CI\njobs:\n${jobs}`;

it("expands a matrix job into one named instance per cell", () => {
  const jobs = deriveCiTestJobs(
    workflow(`  test_server:
    name: Test Server \${{ matrix.shard }}
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - run: vp run --filter t3 test --shard \${{ matrix.shard }}/\${{ strategy.job-total }}
`),
  );
  assert.deepStrictEqual(
    jobs.map((job) => [job.name, job.commands]),
    [1, 2, 3].map((shard) => [
      `Test Server ${shard}`,
      [["run", "--filter", "t3", "test", "--shard", `${shard}/3`]],
    ]),
  );
});

it("keeps every vp step in order, skips provisioning, and reads vpr as vp run", () => {
  const [job] = deriveCiTestJobs(
    workflow(`  check:
    name: Check
    steps:
      - run: vp check
  test:
    name: Test
    steps:
      - uses: actions/checkout@v6
      - run: vp run --filter @t3tools/desktop ensure:electron
      - run: sudo apt-get update && sudo apt-get install -y libsecret-1-dev pkg-config
      - run: |
          git remote add upstream https://github.com/pingdotgg/t3code.git
          git fetch --no-tags upstream main
      - run: vpr test --filter '!t3' --filter "!@t3tools/web"
`),
  );
  assert.deepStrictEqual(job, {
    id: "test",
    name: "Test",
    commands: [
      ["run", "--filter", "@t3tools/desktop", "ensure:electron"],
      ["run", "test", "--filter", "!t3", "--filter", "!@t3tools/web"],
    ],
  });
});

it("downloads the server browser without reinstalling runner-only system libraries", () => {
  const [job] = deriveCiTestJobs(
    workflow(`  test_server:
    steps:
      - run: node apps/server/node_modules/playwright-core/cli.js install --with-deps --only-shell chromium
      - run: vp run --filter t3 test
`),
  );
  assert.deepStrictEqual(job?.commands, [
    [
      "exec",
      "node",
      "apps/server/node_modules/playwright-core/cli.js",
      "install",
      "--only-shell",
      "chromium",
    ],
    ["run", "--filter", "t3", "test"],
  ]);
});

it("refuses a test job step it cannot run exactly", () => {
  const derive = (step: string) => () =>
    deriveCiTestJobs(workflow(`  test:\n    name: Test\n    steps:\n      - run: ${step}\n`));
  assert.throws(derive("node scripts/check.ts"), /cannot run/);
  assert.throws(derive("vp run test | tee log"), /unsupported shell syntax/);
  assert.throws(derive("vp run test --shard ${{ matrix.shard }}"), /unresolvable expression/);
});

it("refuses a test job with no vp command", () => {
  assert.throws(
    () =>
      deriveCiTestJobs(
        workflow(`  test:\n    name: Test\n    steps:\n      - uses: actions/checkout@v6\n`),
      ),
    /runs no vp command/,
  );
});

it("splits quoted words and rejects shell operators", () => {
  assert.deepStrictEqual(shellWords(`vp run --filter '!t3' "a b" c`), [
    "vp",
    "run",
    "--filter",
    "!t3",
    "a b",
    "c",
  ]);
  assert.throws(() => shellWords("vp run a && vp run b"), /unsupported shell syntax/);
  assert.throws(() => shellWords("vp run 'open"), /unterminated quote/);
});
