import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Binder from "./ZmuxSessionBinder.ts";

const output = (stdout = "", code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const project = JSON.stringify({
  workspace: "project",
  session: "main",
  target: "project/main",
  match: "workspace-main",
  tmuxName: "zws_project__main",
  nativeId: "$22",
  state: "live",
  binding: { branch: null, worktreePath: null },
});
const worktree = JSON.stringify({
  workspace: "project",
  session: "feature",
  target: "project/feature",
  match: "worktree",
  tmuxName: "zws_project__feature",
  nativeId: "$23",
  serverId: "123:456",
  createdAt: 789,
  state: "live",
  binding: { branch: "feature", worktreePath: "/repo/project-worktree" },
});
const ensured = (linked = false, status = "created") =>
  JSON.stringify({
    status,
    code: "ok",
    workspace: "project",
    session: linked ? "feature" : "main",
    target: linked ? "project/feature" : "project/main",
    repositoryRoot: linked ? "/repo/project-worktree" : "/repo/project",
    cwd: linked ? "/repo/project-worktree" : "/repo/project",
    nativeId: linked ? "$23" : "$22",
  });

function layer(run: ProcessRunner.ProcessRunner["Service"]["run"], topLevel = "/repo/project") {
  const routed: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    input.command !== "git"
      ? run(input)
      : Effect.succeed(
          output(
            input.args.includes("worktree")
              ? "worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n"
              : input.args.includes("symbolic-ref")
                ? "refs/heads/main\n"
                : `${topLevel}\n`,
          ),
        );
  return Binder.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run: routed })),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest({ terminalSessionMode: "zmux" })),
    Layer.provide(NodePath.layer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { PATH: "/usr/bin" })),
  );
}

describe("ZmuxSessionBinder atomic checkout ensure", () => {
  for (const state of ["created", "reused", "restored"] as const)
    it.effect(`${state} canonical session uses atomic ensure and strict readback`, () => {
      let resolves = 0;
      const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
        if (input.args[0] === "session") {
          resolves++;
          return Effect.succeed(output(resolves === 1 ? "" : project, resolves === 1 ? 1 : 0));
        }
        return Effect.succeed(output(ensured(false, state)));
      });
      return Effect.gen(function* () {
        const binder = yield* Binder.ZmuxSessionBinder;
        assert.deepStrictEqual(
          yield* binder.ensure("/repo/project", { projectPath: "/repo/project" }),
          { status: "ensured", target: "project/main", workspace: "project", session: "main" },
        );
        assert.deepStrictEqual(
          run.mock.calls.map(([i]) => i.args),
          [
            ["session", "resolve", "--cwd", "/repo/project", "--json"],
            [
              "checkout",
              "ensure",
              "--workspace",
              "project",
              "--root",
              "/repo/project",
              "--cwd",
              "/repo/project",
              "--no-switch",
              "--json",
              "--create-workspace",
            ],
            ["session", "resolve", "--cwd", "/repo/project", "--json"],
          ],
        );
      }).pipe(Effect.provide(layer(run)));
    });
  it.effect("linked setup shares the same atomic ensure", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(
        output(
          input.args[0] === "session"
            ? input.args[3] === "/repo/project"
              ? project
              : worktree
            : ensured(true),
        ),
      ),
    );
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      assert.deepStrictEqual(
        yield* binder.bind("/repo/project-worktree", { projectPath: "/repo/project" }),
        { status: "bound", target: "project/feature", outcome: "created" },
      );
      assert.equal(
        run.mock.calls.some(([i]) => i.args[0] === "wt"),
        false,
      );
      assert.deepStrictEqual(run.mock.calls[1]?.[0].args, [
        "checkout",
        "ensure",
        "--workspace",
        "project",
        "--root",
        "/repo/project",
        "--cwd",
        "/repo/project-worktree",
        "--no-switch",
        "--json",
        "--create-workspace",
      ]);
    }).pipe(Effect.provide(layer(run, "/repo/project-worktree")));
  });
  it.effect("surfaces atomic conflict without legacy repair", () => {
    const refusal = JSON.stringify({
      status: "refused",
      code: "repository_conflict",
      workspace: "project",
      session: "",
      target: "",
      nativeId: null,
      message: "workspace root belongs to another Git checkout",
    });
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(input.args[0] === "session" ? output("", 1) : output(refusal, 1)),
    );
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const result = yield* binder.ensure("/repo/project", { projectPath: "/repo/project" });
      assert.equal(result.status, "failed");
      if (result.status === "failed") assert.match(result.notice.detail, /repository_conflict/);
      assert.equal(
        run.mock.calls.some(([i]) => i.args[0] === "workspace" || i.args[0] === "new"),
        false,
      );
    }).pipe(Effect.provide(layer(run)));
  });
  it.effect("serializes concurrent calls around the atomic command", () => {
    let exists = false;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "checkout") {
        const state = exists ? "reused" : "created";
        exists = true;
        return Effect.succeed(output(ensured(false, state)));
      }
      return Effect.succeed(output(exists ? project : "", exists ? 0 : 1));
    });
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const results = yield* Effect.all(
        [
          binder.ensure("/repo/project", { projectPath: "/repo/project" }),
          binder.ensure("/repo/project", { projectPath: "/repo/project" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(
        results.every((r) => r.status === "ensured"),
        true,
      );
      assert.equal(run.mock.calls.filter(([i]) => i.args[0] === "checkout").length, 2);
    }).pipe(Effect.provide(layer(run)));
  });
});
