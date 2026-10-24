// @effect-diagnostics nodeBuiltinImport:off - the preload runs as its own Node process; fixtures need real ones.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const preload = NodePath.join(import.meta.dirname, "await-setup.ts");

/** The preload ahead of an entry that prints `entry ran`, in `cwd`. */
const entry = (cwd: string) =>
  NodeChildProcess.spawn(
    process.execPath,
    ["--import", preload, "-e", "console.log('entry ran')"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

const finished = async (child: NodeChildProcess.ChildProcess) => {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
};

it("holds the entry until a running setup exits", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "await-setup-"));
  const setup = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    NodeFS.mkdirSync(NodePath.join(cwd, ".t3"));
    NodeFS.writeFileSync(NodePath.join(cwd, ".t3", "setup-running"), `${setup.pid}\n`);
    const waiter = entry(cwd);
    const result = finished(waiter);
    // The preload announces the wait while setup lives; only then does setup end.
    await new Promise((resolve) => waiter.stderr.once("data", resolve));
    setup.kill();
    const { code, stdout, stderr } = await result;
    assert.strictEqual(code, 0);
    assert.match(stderr, /waiting for worktree setup/);
    assert.strictEqual(stdout, "entry ran\n");
  } finally {
    setup.kill();
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

it("refuses with the failed setup's tail instead of running the entry", async () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "await-setup-"));
  try {
    NodeFS.mkdirSync(NodePath.join(cwd, ".t3"));
    NodeFS.writeFileSync(NodePath.join(cwd, ".t3", "setup-failed"), "Setup exited with code 1.\n");
    const { code, stdout, stderr } = await finished(entry(cwd));
    assert.strictEqual(code, 1);
    assert.match(stderr, /Setup exited with code 1/);
    assert.strictEqual(stdout, "");
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
