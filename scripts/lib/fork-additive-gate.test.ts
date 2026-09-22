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
