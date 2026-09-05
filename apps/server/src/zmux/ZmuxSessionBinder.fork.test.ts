import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Binder from "./ZmuxSessionBinder.ts";

const output = (stdout = "", code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
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

function layer(
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  topLevel = "/repo/project",
  branch = "main",
) {
  const routed: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
    input.command !== "git"
      ? run(input)
      : Effect.succeed(
          output(
            input.args.includes("worktree")
              ? "worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n"
              : input.args.includes("symbolic-ref")
                ? `refs/heads/${branch}\n`
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
      Effect.succeed(
        input.args[0] === "session"
          ? output("", 1)
          : output(refusal, 1, "checkout ensure failed\n"),
      ),
    );
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const result = yield* binder.ensure("/repo/project", { projectPath: "/repo/project" });
      assert.deepStrictEqual(result, {
        status: "failed",
        notice: {
          summary: "zmux session binding could not be verified",
          detail: "repository_conflict: workspace root belongs to another Git checkout",
        },
      });
      assert.equal(
        run.mock.calls.some(([i]) => i.args[0] === "workspace" || i.args[0] === "new"),
        false,
      );
    }).pipe(Effect.provide(layer(run)));
  });
  it.effect("preserves an older zmux CLI unknown-flag failure", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(
        input.args[0] === "session"
          ? output("", 1)
          : output("", 1, "unknown flag: --create-workspace\n"),
      ),
    );
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const result = yield* binder.ensure("/repo/project", { projectPath: "/repo/project" });

      assert.deepStrictEqual(result, {
        status: "failed",
        notice: {
          summary: "zmux session binding could not be verified",
          detail: "unknown flag: --create-workspace",
        },
      });
    }).pipe(Effect.provide(layer(run)));
  });
  it.effect("rejects malformed JSON from a successful checkout ensure", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(input.args[0] === "session" ? output("", 1) : output("not-json")),
    );
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const result = yield* binder.ensure("/repo/project", { projectPath: "/repo/project" });

      assert.deepStrictEqual(result, {
        status: "failed",
        notice: {
          summary: "zmux session binding could not be verified",
          detail: "zmux returned an invalid checkout ensure response",
        },
      });
    }).pipe(Effect.provide(layer(run)));
  });
  it.effect("accepts the current checkout ensure success protocol", () => {
    let resolves = 0;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        resolves++;
        return Effect.succeed(output(resolves === 1 ? "" : project, resolves === 1 ? 1 : 0));
      }
      return Effect.succeed(output(ensured(false, "created")));
    });
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;

      assert.deepStrictEqual(
        yield* binder.ensure("/repo/project", { projectPath: "/repo/project" }),
        { status: "ensured", target: "project/main", workspace: "project", session: "main" },
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
  it.effect("observes a restorable branch drift without restoring it", () => {
    const restorable = JSON.stringify({
      ...JSON.parse(worktree),
      tmuxName: null,
      nativeId: null,
      state: "restorable",
    });
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(output(restorable)),
    );
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const result = yield* binder.reconcileExisting("/repo/project-worktree");
      assert.equal(result.status, "failed");
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args[0]),
        ["session"],
      );
    }).pipe(Effect.provide(layer(run, "/repo/project-worktree", "renamed")));
  });
  it.effect("keeps explicit slash labels while reconciling a live binding", () => {
    const renamed = JSON.stringify({
      ...JSON.parse(worktree),
      session: "team/renamed",
      target: "project/team/renamed",
      binding: { branch: "team/renamed", worktreePath: "/repo/project-worktree" },
    });
    const ensuredRename = JSON.stringify({
      status: "reused",
      code: "ok",
      workspace: "project",
      session: "team/renamed",
      target: "project/team/renamed",
      repositoryRoot: "/repo/project-worktree",
      cwd: "/repo/project-worktree",
      nativeId: "$23",
    });
    let worktreeResolves = 0;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        const cwd = input.args[input.args.indexOf("--cwd") + 1];
        if (cwd === "/repo/project") return Effect.succeed(output(project));
        worktreeResolves++;
        return Effect.succeed(output(worktreeResolves === 1 ? worktree : renamed));
      }
      return Effect.succeed(output(ensuredRename));
    });
    return Effect.gen(function* () {
      const binder = yield* Binder.ZmuxSessionBinder;
      const result = yield* binder.reconcileExisting("/repo/project-worktree");
      assert.equal(result.status, "resolved");
      if (result.status === "resolved") {
        assert.equal(result.workspace, "project");
        assert.equal(result.session, "team/renamed");
      }
    }).pipe(Effect.provide(layer(run, "/repo/project-worktree", "team/renamed")));
  });
});
