// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { SystemCommandRunner } from "./fork-command.ts";
import { applyAdditiveFixes, checkAdditive } from "./fork-additive.ts";

/**
 * A two-commit upstream history, standing in for a walk's lane: commit 0 is the previous upstream
 * base, the tagged commit 1 is the target, and whatever the test commits on top is the replayed
 * fork head.
 */
const UPSTREAM_LOCAL_API_TEST = [
  'it("delegates the context menu", async () => {',
  '  const items = [{ id: "delete" }];',
  "  await api.contextMenu.show(items);",
  "  expect(showContextMenu).toHaveBeenCalledWith(items, undefined);",
  "});",
  "",
].join("\n");

const upstreamFixture = (): {
  root: string;
  run: (...args: ReadonlyArray<string>) => void;
  write: (path: string, contents: string) => void;
  previous: string;
  target: string;
} => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-additive-"));
  const run = (...args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    });
  };
  const write = (path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), contents);
  };
  run("init", "-b", "fixture");
  // Previous upstream base: a source file with a line upstream will delete, two tests, one migration.
  // The stale hunk is three lines: a lone re-added token is not evidence a hunk came back.
  write(
    "apps/web/src/thing.ts",
    "export const keep = 1;\nexport const stale = () => {\n  return 1;\n};\n",
  );
  write("apps/web/src/thing.test.ts", 'it("first", () => {});\nit("second", () => {});\n');
  write("apps/server/src/persistence/Migrations/001_Base.ts", "export default 1;\n");
  write(
    "apps/server/src/persistence/Migrations.ts",
    [
      'import Migration0001 from "./Migrations/001_Base.ts";',
      "",
      "export const migrationEntries = [",
      '  [1, "Base", Migration0001],',
      "];",
      "",
    ].join("\n"),
  );
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  run("add", "-A");
  run("commit", "-m", "upstream: base");
  const previous = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  // Target: upstream deletes the stale hunk, grows the tests, adds a file and a migration.
  write("apps/web/src/thing.ts", "export const keep = 1;\n");
  write(
    "apps/web/src/thing.test.ts",
    'it("first", () => {});\nit("second", () => {});\nit("third", () => {});\n',
  );
  // An upstream case with a body, so a lost assertion can be told apart from a lost case.
  write("apps/web/src/localApi.test.ts", UPSTREAM_LOCAL_API_TEST);
  write("apps/web/src/gone.ts", "export const gone = 1;\n");
  write("apps/server/src/persistence/Migrations/002_Upstream.ts", "export default 2;\n");
  write(
    "apps/server/src/persistence/Migrations.ts",
    [
      'import Migration0001 from "./Migrations/001_Base.ts";',
      'import Migration0002 from "./Migrations/002_Upstream.ts";',
      "",
      "export const migrationEntries = [",
      '  [1, "Base", Migration0001],',
      '  [2, "Upstream", Migration0002],',
      "];",
      "",
    ].join("\n"),
  );
  run("add", "-A");
  run("commit", "-m", "upstream: grow");
  run("tag", "v1.2.3");
  const target = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  return { root, run, write, previous, target };
};

/** Advance the fixture's lane over the target with `files`, as one clean-applying fork commit. */
const replay = (
  fixture: ReturnType<typeof upstreamFixture>,
  files: ReadonlyArray<readonly [string, string]>,
  subject = "feat: fork drift",
): void => {
  const { run, write } = fixture;
  run("checkout", "-q", fixture.target);
  if (files.length === 0) return;
  for (const [path, contents] of files) write(path, contents);
  run("add", "-A");
  run("commit", "-m", subject);
};

/** What the walk's own repair commit does between a fix and the re-check. */
const commitFixture = (fixture: ReturnType<typeof upstreamFixture>, subject: string): void => {
  fixture.run("add", "-A");
  fixture.run("commit", "-m", subject);
};

const read = (root: string, path: string): string =>
  NodeFS.readFileSync(NodePath.join(root, path), "utf8");

it("passes a purely additive replay on every check", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [["apps/web/src/fork.ts", "export const forkOnly = 1;\n"]]);
  try {
    assert.deepStrictEqual(
      checkAdditive(runner, fixture.root, { target: fixture.target, previous: fixture.previous }),
      [],
    );
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("finds a deleted upstream file and restores it from the target", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, []);
  NodeFS.rmSync(NodePath.join(fixture.root, "apps/web/src/gone.ts"));
  fixture.run("add", "-A");
  fixture.run("commit", "-m", "feat: drop an upstream file");
  try {
    const trees = { target: fixture.target, previous: fixture.previous };
    const findings = checkAdditive(runner, fixture.root, trees);
    assert.deepStrictEqual(
      findings.map(({ check, path, detail }) => ({ check, path, detail })),
      [
        {
          check: "files",
          path: "apps/web/src/gone.ts",
          detail: "upstream file is missing from the replayed tree",
        },
      ],
    );
    const fixes = applyAdditiveFixes(runner, fixture.root, fixture.target, findings);
    assert.deepStrictEqual(fixes.remaining, []);
    assert.deepStrictEqual(fixes.paths, ["apps/web/src/gone.ts"]);
    assert.strictEqual(read(fixture.root, "apps/web/src/gone.ts"), "export const gone = 1;\n");
    commitFixture(fixture, "chore(fork-sync): repair additive after v1.2.3");
    assert.deepStrictEqual(checkAdditive(runner, fixture.root, trees), []);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("renumbers a colliding fork migration and moves its registry entry last", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [
    ["apps/server/src/persistence/Migrations/002_ForkThing.ts", "export default 9;\n"],
    [
      "apps/server/src/persistence/Migrations.ts",
      [
        'import Migration0001 from "./Migrations/001_Base.ts";',
        'import Migration0002 from "./Migrations/002_Upstream.ts";',
        'import Migration0002Fork from "./Migrations/002_ForkThing.ts";',
        "",
        "export const migrationEntries = [",
        '  [1, "Base", Migration0001],',
        '  [2, "ForkThing", Migration0002Fork],',
        '  [2, "Upstream", Migration0002],',
        "];",
        "",
      ].join("\n"),
    ],
  ]);
  try {
    const trees = { target: fixture.target, previous: fixture.previous };
    const findings = checkAdditive(runner, fixture.root, trees);
    const collision = findings.find(({ check }) => check === "migrations");
    assert.deepStrictEqual(
      collision && {
        check: collision.check,
        path: collision.path,
        collidesWith: collision.collidesWith,
      },
      {
        check: "migrations",
        path: "apps/server/src/persistence/Migrations/002_ForkThing.ts",
        collidesWith: "apps/server/src/persistence/Migrations/002_Upstream.ts",
      },
    );
    const fixes = applyAdditiveFixes(runner, fixture.root, fixture.target, findings);
    assert.deepStrictEqual(fixes.remaining, []);
    // Upstream's migration and its registry lines are untouched; the fork's moved past both.
    const registry = read(fixture.root, "apps/server/src/persistence/Migrations.ts");
    assert.include(registry, 'import Migration0003 from "./Migrations/003_ForkThing.ts";');
    assert.include(registry, '[2, "Upstream", Migration0002],');
    assert.include(registry, '[3, "ForkThing", Migration0003],');
    const entryOrder = [
      registry.indexOf('"ForkThing"'),
      registry.indexOf('"Upstream"'),
      registry.indexOf("];"),
    ];
    assert.isBelow(entryOrder[1] ?? 0, entryOrder[0] ?? 0);
    assert.isBelow(entryOrder[0] ?? 0, entryOrder[2] ?? 0);
    assert.isTrue(
      NodeFS.existsSync(
        NodePath.join(fixture.root, "apps/server/src/persistence/Migrations/003_ForkThing.ts"),
      ),
    );
    assert.isFalse(
      NodeFS.existsSync(
        NodePath.join(fixture.root, "apps/server/src/persistence/Migrations/002_ForkThing.ts"),
      ),
    );
    commitFixture(fixture, "chore(fork-sync): repair additive after v1.2.3");
    assert.deepStrictEqual(checkAdditive(runner, fixture.root, trees), []);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("restores a missing upstream migration", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, []);
  NodeFS.rmSync(
    NodePath.join(fixture.root, "apps/server/src/persistence/Migrations/002_Upstream.ts"),
  );
  fixture.run("add", "-A");
  fixture.run("commit", "-m", "feat: drop an upstream migration");
  try {
    const trees = { target: fixture.target, previous: fixture.previous };
    const findings = checkAdditive(runner, fixture.root, trees);
    // The deleted file is both an upstream file and an upstream migration.
    assert.deepStrictEqual(
      findings.map(({ check, path }) => ({ check, path })),
      [
        {
          check: "files",
          path: "apps/server/src/persistence/Migrations/002_Upstream.ts",
        },
        {
          check: "migrations",
          path: "apps/server/src/persistence/Migrations/002_Upstream.ts",
        },
      ],
    );
    const fixes = applyAdditiveFixes(runner, fixture.root, fixture.target, findings);
    assert.deepStrictEqual(fixes.remaining, []);
    assert.strictEqual(
      read(fixture.root, "apps/server/src/persistence/Migrations/002_Upstream.ts"),
      "export default 2;\n",
    );
    commitFixture(fixture, "chore(fork-sync): repair additive after v1.2.3");
    assert.deepStrictEqual(checkAdditive(runner, fixture.root, trees), []);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// The shape the gate used to pass: `apps/web/src/localApi.test.ts` lost its `showContextMenu`
// delegation assertions in `cfd9465bd5f` and the walk reported `findings: 0`, because the case
// itself stayed and declaration counting is all the check had (RSI-Software/t3code-hyprws#697).
it("refuses an assertion deleted from a kept upstream case, and grants the recorded debt", () => {
  const lost = [
    "await api.contextMenu.show(items);",
    "expect(showContextMenu).toHaveBeenCalledWith(items, undefined);",
  ];
  const gutted = [
    'it("delegates the context menu", async () => {',
    '  const items = [{ id: "delete" }];',
    "});",
    "",
  ].join("\n");
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [["apps/web/src/localApi.test.ts", gutted]]);
  try {
    assert.deepStrictEqual(
      checkAdditive(runner, fixture.root, {
        target: fixture.target,
        previous: fixture.previous,
      }).map(({ check, path, lines }) => ({ check, path, lines })),
      [{ check: "tests", path: "apps/web/src/localApi.test.ts", lines: lost.toSorted() }],
    );
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }

  // The sweep is the allow-list: a listed file keeps its debt until the row leaves the table.
  const listed = upstreamFixture();
  replay(listed, [
    ["apps/web/src/localApi.test.ts", gutted],
    [
      "docs/internals/fork-test-divergence.md",
      [
        "# Fork test divergence",
        "",
        "## Upstream test files edited in place (1)",
        "",
        "| File | Diff | Class |",
        "| --- | --- | --- |",
        "| `apps/web/src/localApi.test.ts` | +0 / −2 | deletion |",
        "",
      ].join("\n"),
    ],
  ]);
  try {
    assert.deepStrictEqual(
      checkAdditive(runner, listed.root, { target: listed.target, previous: listed.previous }),
      [],
    );
  } finally {
    NodeFS.rmSync(listed.root, { recursive: true, force: true });
  }
});

it("refuses a rewritten upstream case and a shrunk upstream test file", () => {
  // Same case count, one line rewritten in place: the shape the fork's ChatMarkdown edit takes,
  // and the one declaration counting alone reports as a pass.
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [
    [
      "apps/web/src/thing.test.ts",
      'it("first", () => { assert(1); });\nit("second", () => {});\nit("third", () => {});\n',
    ],
  ]);
  try {
    assert.deepStrictEqual(
      checkAdditive(runner, fixture.root, {
        target: fixture.target,
        previous: fixture.previous,
      }).map(({ check, path, lines, detail }) => ({ check, path, lines, detail })),
      [
        {
          check: "tests",
          path: "apps/web/src/thing.test.ts",
          lines: ['it("first", () => {});'],
          detail:
            "1 upstream test line(s) are gone from the replayed tree; a fork commit may only append to an upstream test file",
        },
      ],
    );
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }

  const shrunk = upstreamFixture();
  replay(shrunk, [
    ["apps/web/src/thing.test.ts", 'it("first", () => {});\nit("second", () => {});\n'],
  ]);
  try {
    const trees = { target: shrunk.target, previous: shrunk.previous };
    const findings = checkAdditive(runner, shrunk.root, trees);
    assert.deepStrictEqual(
      findings.map(({ check, path, upstream, head, detail }) => ({
        check,
        path,
        upstream,
        head,
        detail,
      })),
      [
        {
          check: "tests",
          path: "apps/web/src/thing.test.ts",
          upstream: undefined,
          head: undefined,
          detail:
            "1 upstream test line(s) are gone from the replayed tree; a fork commit may only append to an upstream test file",
        },
        {
          check: "tests",
          path: "apps/web/src/thing.test.ts",
          upstream: 3,
          head: 2,
          detail: "test declarations shrunk from 3 to 2",
        },
      ],
    );
    const fixes = applyAdditiveFixes(runner, shrunk.root, shrunk.target, findings);
    assert.deepStrictEqual(fixes.fixed, []);
    assert.deepStrictEqual(fixes.paths, []);
    // The refusals keep their finding but name the shape that declined them.
    assert.deepStrictEqual(
      fixes.remaining.map(({ detail }) => detail),
      [
        `${findings[0]?.detail} — no fix: upstream test lines are gone from a file the replay kept; which line comes back is a maintainer's call`,
        `${findings[1]?.detail} — no fix: the upstream test file shrank from 3 to 2 declaration(s) rather than vanishing; only a wholly missing file restores`,
      ],
    );
  } finally {
    NodeFS.rmSync(shrunk.root, { recursive: true, force: true });
  }
});

it("counts a skipped case as absent and refuses new skip markers", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [
    [
      "apps/web/src/thing.test.ts",
      'it("first", () => {});\nit("second", () => {});\nit.skip("third", () => {});\n',
    ],
  ]);
  try {
    const findings = checkAdditive(runner, fixture.root, {
      target: fixture.target,
      previous: fixture.previous,
    });
    assert.deepStrictEqual(
      findings.map(({ check, detail }) => ({ check, detail })),
      [
        {
          check: "tests",
          detail:
            "1 upstream test line(s) are gone from the replayed tree; a fork commit may only append to an upstream test file",
        },
        { check: "tests", detail: "test declarations shrunk from 3 to 2" },
        { check: "tests", detail: "adds 1 .skip/.todo/.only marker(s) upstream does not carry" },
      ],
    );
    assert.deepStrictEqual(
      applyAdditiveFixes(runner, fixture.root, fixture.target, findings).paths,
      [],
    );
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("restores a wholly missing upstream test file", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, []);
  NodeFS.rmSync(NodePath.join(fixture.root, "apps/web/src/thing.test.ts"));
  fixture.run("add", "-A");
  fixture.run("commit", "-m", "feat: drop an upstream test");
  try {
    const trees = { target: fixture.target, previous: fixture.previous };
    const findings = checkAdditive(runner, fixture.root, trees);
    const tests = findings.filter(({ check }) => check === "tests");
    assert.deepStrictEqual(
      tests.map(({ path, upstream, head }) => ({ path, upstream, head })),
      [{ path: "apps/web/src/thing.test.ts", upstream: 3, head: 0 }],
    );
    const fixes = applyAdditiveFixes(runner, fixture.root, fixture.target, findings);
    assert.deepStrictEqual(fixes.remaining, []);
    assert.include(read(fixture.root, "apps/web/src/thing.test.ts"), 'it("third"');
    commitFixture(fixture, "chore(fork-sync): repair additive after v1.2.3");
    assert.deepStrictEqual(checkAdditive(runner, fixture.root, trees), []);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("catches a clean-applying fork commit re-adding what upstream deleted, and drops the re-add", () => {
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [
    [
      "apps/web/src/thing.ts",
      "export const keep = 1;\nexport const stale = () => {\n  return 1;\n};\n",
    ],
  ]);
  try {
    const trees = { target: fixture.target, previous: fixture.previous };
    const findings = checkAdditive(runner, fixture.root, trees);
    assert.deepStrictEqual(
      findings.map(({ check, path, lines, detail }) => ({ check, path, lines, detail })),
      [
        {
          check: "readded",
          path: "apps/web/src/thing.ts",
          lines: ["export const stale = () => {", "return 1;", "};"],
          detail: "re-adds 1 hunk(s) upstream deleted",
        },
      ],
    );
    const fixes = applyAdditiveFixes(runner, fixture.root, fixture.target, findings);
    assert.deepStrictEqual(fixes.remaining, []);
    assert.strictEqual(read(fixture.root, "apps/web/src/thing.ts"), "export const keep = 1;\n");
    commitFixture(fixture, "chore(fork-sync): repair additive after v1.2.3");
    assert.deepStrictEqual(checkAdditive(runner, fixture.root, trees), []);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("ignores a comment and a lone re-added token, and refuses a brace-dangling removal", () => {
  // Upstream deleted a code hunk; the fork's replay adds only a comment about it. A comment is
  // not the deleted hunk, so nothing came back.
  const fixture = upstreamFixture();
  const runner = new SystemCommandRunner();
  replay(fixture, [["apps/web/src/thing.ts", "export const keep = 1;\n// stale is gone\n"]]);
  try {
    assert.deepStrictEqual(
      checkAdditive(runner, fixture.root, { target: fixture.target, previous: fixture.previous }),
      [],
    );
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }

  // Upstream deleted a closing brace and the replay writes one of its own. A single structural
  // token is syntax, not upstream intent coming back, so the check leaves the tree alone: cutting
  // it is what leaves the block dangling.
  const dangling = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-additive-dangling-"));
  const run = (...args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, {
      cwd: dangling,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    });
  };
  const write = (path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dangling, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dangling, path), contents);
  };
  run("init", "-b", "fixture");
  write("apps/web/src/block.ts", "export const block = () => {\n  return 1;\n};\n");
  run("add", "-A");
  run("commit", "-m", "upstream: block");
  const previous = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: dangling })
    .toString()
    .trim();
  write("apps/web/src/block.ts", "export const block = () => {\n  return 1;\n");
  run("add", "-A");
  run("commit", "-m", "upstream: drop the brace");
  const target = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: dangling })
    .toString()
    .trim();
  write("apps/web/src/block.ts", "export const block = () => {\n  return 1;\n};\n");
  run("add", "-A");
  run("commit", "-m", "feat: re-add the brace");
  try {
    const findings = checkAdditive(runner, dangling, { target, previous });
    assert.deepStrictEqual(findings, []);
    const fixes = applyAdditiveFixes(runner, dangling, target, findings);
    assert.deepStrictEqual(fixes.fixed, []);
    assert.deepStrictEqual(fixes.remaining, []);
    assert.strictEqual(
      read(dangling, "apps/web/src/block.ts"),
      "export const block = () => {\n  return 1;\n};\n",
    );
  } finally {
    NodeFS.rmSync(dangling, { recursive: true, force: true });
  }
});
