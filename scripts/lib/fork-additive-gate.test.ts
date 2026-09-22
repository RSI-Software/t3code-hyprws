// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { checkAdditive } from "./fork-additive-gate.ts";
import { SystemCommandRunner } from "./fork-command.ts";

const fixture = (): {
  root: string;
  run: (...args: ReadonlyArray<string>) => void;
  write: (path: string, contents: string) => void;
  commit: (message: string) => void;
} => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-additive-gate-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const run = (...args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, { cwd: root, env });
  };
  const write = (path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), contents);
  };
  const commit = (message: string): void => {
    run("add", "-A");
    run("commit", "-m", message);
  };
  run("init", "-b", "fixture");
  return { root, run, write, commit };
};

const runner = new SystemCommandRunner();

const commitEnv = { ...process.env };

const commitAll = (root: string, message: string): void => {
  NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["commit", "-m", message], {
    cwd: root,
    env: {
      ...commitEnv,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
};

it("passes a pure-addition head", () => {
  const { root, run, write, commit } = fixture();
  write("apps/web/src/thing.ts", "export const keep = 1;\n");
  write("apps/web/src/thing.test.ts", 'it("first", () => {});\n');
  write("apps/server/src/persistence/Migrations/001_Base.ts", "export default 1;\n");
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  write("apps/web/src/added.ts", "export const added = 2;\n");
  commit("fork: add");
  assert.deepStrictEqual(checkAdditive(runner, root, { base, since: base }), []);
});

it("flags a deleted upstream file", () => {
  const { root, run, write, commit } = fixture();
  write("apps/web/src/thing.ts", "export const keep = 1;\n");
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  NodeFS.unlinkSync(NodePath.join(root, "apps/web/src/thing.ts"));
  commit("fork: delete");
  const findings = checkAdditive(runner, root, { base, since: base });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, "files");
  assert.equal(findings[0]?.path, "apps/web/src/thing.ts");
});

it("flags a migration number collision and a shrunk test", () => {
  const { root, run, write, commit } = fixture();
  write("apps/web/src/thing.test.ts", 'it("first", () => {});\nit("second", () => {});\n');
  write("apps/server/src/persistence/Migrations/001_Base.ts", "export default 1;\n");
  write("apps/server/src/persistence/Migrations/002_Next.ts", "export default 2;\n");
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  write("apps/server/src/persistence/Migrations/002_Fork.ts", "export default 3;\n");
  write("apps/web/src/thing.test.ts", 'it("first", () => {});\n');
  commit("fork: collide and shrink");
  const findings = checkAdditive(runner, root, { base, since: base });
  assert.isTrue(findings.some((finding) => finding.check === "migrations"));
  assert.isTrue(findings.some((finding) => finding.check === "tests"));
});

it("flags a removed upstream test line even when declarations hold", () => {
  const { root, run, write, commit } = fixture();
  write("apps/web/src/thing.test.ts", 'it("first", () => {\n  expect(keep).toBe(1);\n});\n');
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  write("apps/web/src/thing.test.ts", 'it("first", () => {\n  expect(keep).toBe(2);\n});\n');
  commit("fork: rewrite assertion");
  const findings = checkAdditive(runner, root, { base, since: base });
  assert.isTrue(
    findings.some((finding) => finding.check === "tests" && /gone/.test(finding.detail)),
  );
});

it("does not count a declared-superseded case as a shrink, and still shrinks an undeclared one", () => {
  // RSI-Software/t3code-hyprws#1208: the sibling declares the upstream title the fork
  // contradicts under a DIFFERENT replacement title, so the declaration must carry
  // the exemption — counting same-titled sibling cases keeps the deadlock. The
  // replacement case must exist: a bare declaration buys nothing.
  const setup = (): { root: string; base: string; since: string } => {
    const { root, run, write, commit } = fixture();
    write(
      "apps/web/src/thing.test.ts",
      'it("upstream", () => {\n  expect(keep).toBe(1);\n});\nit("other", () => {});\n',
    );
    commit("upstream: base");
    const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
    return { root, base, since: base };
  };
  const declaredSibling = [
    'forkSupersedes({ upstream: "apps/web/src/thing.test.ts > upstream", reason: "the fork inverts it", commit: "abc1234" });',
    'it("replacement", () => {',
    "  expect(keep).toBe(2);",
    "});",
    "",
  ].join("\n");
  {
    // Declared, replacement present, upstream case deleted: no tests finding.
    const { root, base, since } = setup();
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.test.ts"),
      'it("other", () => {});\n',
    );
    NodeFS.writeFileSync(NodePath.join(root, "apps/web/src/thing.fork.test.ts"), declaredSibling);
    commitAll(root, "fork: delete declared case, declare in sibling");
    assert.deepStrictEqual(checkAdditive(runner, root, { base, since }), []);
  }
  {
    // Bare declaration, no replacement case: the shrink still fires.
    const { root, base, since } = setup();
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.test.ts"),
      'it("other", () => {});\n',
    );
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.fork.test.ts"),
      'forkSupersedes({ upstream: "apps/web/src/thing.test.ts > upstream", reason: "the fork inverts it", commit: "abc1234" });\n',
    );
    commitAll(root, "fork: delete with a bare declaration");
    const findings = checkAdditive(runner, root, { base, since });
    assert.isTrue(findings.some((finding) => finding.check === "tests"));
  }
  {
    // No declaration at all: the shrink still fires exactly as today.
    const { root, base, since } = setup();
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.test.ts"),
      'it("other", () => {});\n',
    );
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.fork.test.ts"),
      'it("replacement", () => {\n  expect(keep).toBe(2);\n});\n',
    );
    commitAll(root, "fork: delete with no declaration");
    const findings = checkAdditive(runner, root, { base, since });
    assert.isTrue(findings.some((finding) => finding.check === "tests"));
  }
});

it("lets a fork-added line leave freely but guards upstream lines via the sibling", () => {
  // Base carries an upstream case; since adds a fork case on top. A line
  // the fork added itself may leave the upstream-owned file freely; only
  // an upstream-carried line must MOVE to the `.fork.test.ts` sibling.
  const setup = (): { root: string; base: string; since: string } => {
    const { root, run, write, commit } = fixture();
    write("apps/web/src/thing.test.ts", 'it("upstream", () => {});\n');
    commit("upstream: base");
    const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
    write("apps/web/src/thing.test.ts", 'it("upstream", () => {});\nit("fork", () => {});\n');
    commit("fork: add case in place");
    const since = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
    return { root, base, since };
  };
  {
    const { root, base, since } = setup();
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.test.ts"),
      'it("upstream", () => {});\n',
    );
    commitAll(root, "fork: drop fork case");
    assert.deepStrictEqual(checkAdditive(runner, root, { base, since }), []);
  }
  {
    const { root, base, since } = setup();
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.test.ts"),
      'it("fork", () => {});\n',
    );
    commitAll(root, "fork: drop upstream case");
    const findings = checkAdditive(runner, root, { base, since });
    assert.isTrue(
      findings.some((finding) => finding.check === "tests" && /no .* sibling/.test(finding.detail)),
    );
  }
  {
    const { root, base, since } = setup();
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.test.ts"),
      'it("fork", () => {});\n',
    );
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.fork.test.ts"),
      'it("upstream", () => {});\n',
    );
    commitAll(root, "fork: move upstream case to sibling");
    assert.deepStrictEqual(checkAdditive(runner, root, { base, since }), []);
  }
});

it("excuses a named upstream case a live declaration supersedes, and holds an unnamed one", () => {
  // The fork moves the whole upstream case body into the sibling beside a
  // forkSupersedes declaration: the named case's lines are superseded
  // rather than contradictory, so no tests finding fires.
  const setup = (): { root: string; base: string; since: string } => {
    const { root, run, write, commit } = fixture();
    write("apps/web/src/thing.test.ts", 'it("upstream", () => {\n  expect(keep).toBe(1);\n});\n');
    commit("upstream: base");
    const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
    return { root, base, since: base };
  };
  {
    const { root, base, since } = setup();
    NodeFS.writeFileSync(NodePath.join(root, "apps/web/src/thing.test.ts"), "");
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.fork.test.ts"),
      [
        'forkSupersedes({ upstream: "apps/web/src/thing.test.ts > upstream", reason: "the fork inverts it", commit: "abc1234" });',
        'it("upstream", () => {',
        "  expect(keep).toBe(2);",
        "});",
        "",
      ].join("\n"),
    );
    commitAll(root, "fork: supersede with a declaration");
    assert.deepStrictEqual(checkAdditive(runner, root, { base, since }), []);
  }
  {
    // Same move, no declaration: the lost lines stay a finding.
    const { root, base, since } = setup();
    NodeFS.writeFileSync(NodePath.join(root, "apps/web/src/thing.test.ts"), "");
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.fork.test.ts"),
      'it("upstream", () => {\n  expect(keep).toBe(2);\n});\n',
    );
    commitAll(root, "fork: supersede without a declaration");
    const findings = checkAdditive(runner, root, { base, since });
    assert.isTrue(
      findings.some((finding) => finding.check === "tests" && /gone/.test(finding.detail)),
    );
  }
  {
    // A declaration names one case only: a second moved case it does not
    // name stays a finding. Two cases live here from the start so the
    // since tree (base2) still carries both.
    const { root, run, write, commit } = fixture();
    write(
      "apps/web/src/thing.test.ts",
      'it("upstream", () => {\n  expect(keep).toBe(1);\n});\nit("other", () => {\n  expect(keep).toBe(1);\n});\n',
    );
    commit("upstream: base");
    const base2 = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
    NodeFS.writeFileSync(NodePath.join(root, "apps/web/src/thing.test.ts"), "");
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/web/src/thing.fork.test.ts"),
      [
        'forkSupersedes({ upstream: "apps/web/src/thing.test.ts > upstream", reason: "the fork inverts it", commit: "abc1234" });',
        'it("upstream", () => {',
        "  expect(keep).toBe(1);",
        "});",
        'it("other", () => {',
        "  expect(keep).toBe(2);",
        "});",
        "",
      ].join("\n"),
    );
    commitAll(root, "fork: move two, declare one");
    const findings = checkAdditive(runner, root, { base: base2, since: base2 });
    // The unnamed "other" case stays a finding even though its lines
    // moved to the sibling: only the declared case is superseded.
    assert.isTrue(findings.some((finding) => finding.check === "tests"));
  }
});

it("lets a fork-created test leave with its source", () => {
  const { root, write, commit } = fixture();
  write("apps/web/src/thing.ts", "export const keep = 1;\n");
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  write("apps/web/src/feature.ts", "export const feature = 1;\n");
  write("apps/web/src/feature.test.ts", 'it("fork case", () => {});\n');
  commit("fork: add feature with test");
  const since = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  NodeFS.unlinkSync(NodePath.join(root, "apps/web/src/feature.ts"));
  NodeFS.unlinkSync(NodePath.join(root, "apps/web/src/feature.test.ts"));
  commitAll(root, "fork: drop feature");
  assert.deepStrictEqual(checkAdditive(runner, root, { base, since }), []);
});

it("still refuses deleting an upstream-carried test", () => {
  const { root, write, commit } = fixture();
  write("apps/web/src/thing.test.ts", 'it("first", () => {});\nit("second", () => {});\n');
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  write("apps/web/src/extra.ts", "export const extra = 1;\n");
  commit("fork: add unrelated file");
  const since = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  NodeFS.unlinkSync(NodePath.join(root, "apps/web/src/thing.test.ts"));
  commitAll(root, "fork: delete upstream test");
  const findings = checkAdditive(runner, root, { base, since });
  assert.isTrue(
    findings.some((finding) => finding.check === "tests" && /missing/.test(finding.detail)),
  );
});

it("still flags .skip markers in a fork-created test", () => {
  const { root, write, commit } = fixture();
  write("apps/web/src/thing.ts", "export const keep = 1;\n");
  commit("upstream: base");
  const base = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  write("apps/web/src/feature.test.ts", 'it.skip("fork case", () => {});\n');
  commit("fork: add skipped test");
  const since = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  const findings = checkAdditive(runner, root, { base, since });
  assert.isTrue(
    findings.some((finding) => finding.check === "tests" && /\.skip/.test(finding.detail)),
  );
});
