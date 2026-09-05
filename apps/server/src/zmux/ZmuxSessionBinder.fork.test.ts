import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ZmuxSessionBinder from "./ZmuxSessionBinder.ts";

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

const resolvedProject = JSON.stringify({
  workspace: "project",
  session: "main",
  target: "project/main",
  match: "workspace-main",
  tmuxName: "zws_project__main",
  nativeId: "$22",
  state: "live",
  binding: { branch: null, worktreePath: null },
});

const resolvedWorktree = JSON.stringify({
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

const bound = JSON.stringify({
  session: {
    qualified: "project/feature",
    tmuxName: "zws_project__feature",
    tmuxId: "$23",
  },
  worktree: { path: "/repo/project-worktree", branch: "feature" },
  created: true,
  reused: false,
  restored: false,
  renamed: false,
});

function makeLayer(
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  options: { readonly detachedHead?: boolean; readonly topLevel?: string } = {},
) {
  const runWithGitIdentity: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    if (input.command !== "git") return run(input);
    if (input.args.includes("symbolic-ref") && options.detachedHead) {
      return Effect.succeed(output("", 1));
    }
    if (input.args.includes("symbolic-ref")) {
      return Effect.succeed(output("refs/heads/main\n"));
    }
    if (input.args.includes("worktree")) {
      return Effect.succeed(
        output("worktree /repo/project\nHEAD abc123\nbranch refs/heads/main\n"),
      );
    }
    return Effect.succeed(output(`${options.topLevel ?? input.args[1]}\n`));
  };
  return ZmuxSessionBinder.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run: runWithGitIdentity })),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest({ terminalSessionMode: "zmux" })),
    Layer.provide(NodePath.layer),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { PATH: "/usr/bin" })),
  );
}

const bindProjectWorktree = Effect.gen(function* () {
  const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
  return yield* binder.bind("/repo/project-worktree", { projectPath: "/repo/project" });
});

const ensureProjectCheckout = Effect.gen(function* () {
  const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
  return yield* binder.ensure("/repo/project", { projectPath: "/repo/project" });
});

describe("ZmuxSessionBinder project workspace guard", () => {
  it.effect("ensures an existing canonical main session without mutation", () => {
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(output(resolvedProject)),
    );

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* ensureProjectCheckout, {
        status: "ensured",
        target: "project/main",
        workspace: "project",
        session: "main",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args),
        [["session", "resolve", "--cwd", "/repo/project", "--json"]],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("creates a missing canonical workspace and keeps the literal main session", () => {
    let resolveCalls = 0;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        resolveCalls += 1;
        return Effect.succeed(resolveCalls < 3 ? output("", 1) : output(resolvedProject));
      }
      return Effect.succeed(output("", 1, "attach requires a terminal"));
    });

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* ensureProjectCheckout, {
        status: "ensured",
        target: "project/main",
        workspace: "project",
        session: "main",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args),
        [
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          ["new", "project"],
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
        ],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("restores a canonical restorable session and verifies its live identity", () => {
    let resolveCalls = 0;
    const restorableProject = JSON.stringify({
      ...JSON.parse(resolvedProject),
      nativeId: null,
      tmuxName: null,
      state: "restorable",
    });
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        resolveCalls += 1;
        return Effect.succeed(output(resolveCalls === 1 ? restorableProject : resolvedProject));
      }
      return Effect.succeed(output("", 1, "attach requires a terminal"));
    });

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* ensureProjectCheckout, {
        status: "ensured",
        target: "project/main",
        workspace: "project",
        session: "main",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args),
        [
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          ["open", "project", "main"],
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
        ],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("serializes repeated first-use ensures so the workspace is created once", () => {
    let workspaceExists = false;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "new") {
        workspaceExists = true;
        return Effect.succeed(output("", 1, "attach requires a terminal"));
      }
      return Effect.succeed(
        output(workspaceExists ? resolvedProject : "", workspaceExists ? 0 : 1),
      );
    });

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const results = yield* Effect.all(
        [
          binder.ensure("/repo/project", { projectPath: "/repo/project" }),
          binder.ensure("/repo/project", { projectPath: "/repo/project" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(results, [
        { status: "ensured", target: "project/main", workspace: "project", session: "main" },
        { status: "ensured", target: "project/main", workspace: "project", session: "main" },
      ]);
      assert.equal(run.mock.calls.filter(([input]) => input.args[0] === "new").length, 1);
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("adopts an existing unbound worktree with explicit workspace identity", () => {
    let worktreeResolveCalls = 0;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        if (input.args[3] === "/repo/project-worktree") {
          worktreeResolveCalls += 1;
          return Effect.succeed(
            worktreeResolveCalls === 1 ? output("", 1) : output(resolvedWorktree),
          );
        }
        return Effect.succeed(output(resolvedProject));
      }
      return Effect.succeed(output(bound));
    });

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      assert.deepStrictEqual(yield* binder.ensure("/repo/project-worktree"), {
        status: "ensured",
        target: "project/feature",
        workspace: "project",
        session: "feature",
      });
      assert.deepStrictEqual(run.mock.calls.at(2)?.[0].args, [
        "wt",
        "--adopt",
        "/repo/project-worktree",
        "--workspace",
        "project",
        "--root",
        "/repo/project",
        "--yes",
        "--json",
        "--no-switch",
      ]);
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("keeps an exact live binding usable while the checkout is detached", () => {
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(output(resolvedProject)),
    );

    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* ensureProjectCheckout, {
        status: "ensured",
        target: "project/main",
        workspace: "project",
        session: "main",
      });
      assert.equal(run.mock.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(run, { detachedHead: true })));
  });

  it.effect("refuses to adopt a missing binding while the checkout is detached", () => {
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) => Effect.succeed(output("", 1)));

    return Effect.gen(function* () {
      const result = yield* ensureProjectCheckout;
      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.notice.summary, "Git checkout could not be verified");
      assert.match(result.notice.detail, /detached HEAD/);
      assert.equal(run.mock.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(run, { detachedHead: true })));
  });

  it.effect("reports a resolver timeout separately from a missing binding", () => {
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed({ ...output("", 1), timedOut: true }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.resolve("/repo/project");
      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.notice.summary, "zmux session lookup timed out");
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("normalizes a canonical subdirectory to its checkout root", () => {
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed(output(resolvedProject)),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      assert.deepStrictEqual(yield* binder.ensure("/repo/project/packages/app"), {
        status: "ensured",
        target: "project/main",
        workspace: "project",
        session: "main",
      });
      assert.deepStrictEqual(run.mock.calls[0]?.[0].args, [
        "session",
        "resolve",
        "--cwd",
        "/repo/project",
        "--json",
      ]);
    }).pipe(Effect.provide(makeLayer(run, { topLevel: "/repo/project" })));
  });
  it.effect("reuses a workspace that already resolves from the project root", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] !== "session") return Effect.succeed(output(bound));
      return Effect.succeed(
        output(input.args[3] === "/repo/project" ? resolvedProject : resolvedWorktree),
      );
    });

    return Effect.gen(function* () {
      const result = yield* bindProjectWorktree;

      assert.deepStrictEqual(result, {
        status: "bound",
        target: "project/feature",
        outcome: "created",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args),
        [
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          [
            "wt",
            "--adopt",
            "/repo/project-worktree",
            "--workspace",
            "project",
            "--root",
            "/repo/project",
            "--yes",
            "--json",
            "--no-switch",
          ],
          ["session", "resolve", "--cwd", "/repo/project-worktree", "--json"],
        ],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("creates a missing workspace at the project root before adoption", () => {
    let resolveCalls = 0;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      switch (input.args[0]) {
        case "session":
          resolveCalls += 1;
          return Effect.succeed(
            resolveCalls === 1
              ? output("", 1)
              : output(resolveCalls === 2 ? resolvedProject : resolvedWorktree),
          );
        case "new":
          return Effect.succeed(output("", 1, "open terminal failed: not a terminal"));
        default:
          return Effect.succeed(output(bound));
      }
    });

    return Effect.gen(function* () {
      const result = yield* bindProjectWorktree;

      assert.deepStrictEqual(result, {
        status: "bound",
        target: "project/feature",
        outcome: "created",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => ({ args: input.args, cwd: input.cwd })),
        [
          {
            args: ["session", "resolve", "--cwd", "/repo/project", "--json"],
            cwd: undefined,
          },
          { args: ["new", "project"], cwd: "/repo/project" },
          {
            args: ["session", "resolve", "--cwd", "/repo/project", "--json"],
            cwd: undefined,
          },
          {
            args: [
              "wt",
              "--adopt",
              "/repo/project-worktree",
              "--workspace",
              "project",
              "--root",
              "/repo/project",
              "--yes",
              "--json",
              "--no-switch",
            ],
            cwd: undefined,
          },
          {
            args: ["session", "resolve", "--cwd", "/repo/project-worktree", "--json"],
            cwd: undefined,
          },
        ],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("repairs a broad or stale workspace root before adoption", () => {
    let resolveCalls = 0;
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        resolveCalls += 1;
        return Effect.succeed(
          resolveCalls < 3
            ? output("", 1)
            : output(resolveCalls === 3 ? resolvedProject : resolvedWorktree),
        );
      }
      if (input.args[0] === "new") {
        return Effect.succeed(output("", 1, 'workspace "project" already exists'));
      }
      if (input.args[0] === "workspace") {
        return Effect.succeed(output("Workspace project root → /repo/project"));
      }
      return Effect.succeed(output(bound));
    });

    return Effect.gen(function* () {
      const result = yield* bindProjectWorktree;

      assert.deepStrictEqual(result, {
        status: "bound",
        target: "project/feature",
        outcome: "created",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args),
        [
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          ["new", "project"],
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          ["workspace", "set-root", "project", "/repo/project"],
          ["session", "resolve", "--cwd", "/repo/project", "--json"],
          [
            "wt",
            "--adopt",
            "/repo/project-worktree",
            "--workspace",
            "project",
            "--root",
            "/repo/project",
            "--yes",
            "--json",
            "--no-switch",
          ],
          ["session", "resolve", "--cwd", "/repo/project-worktree", "--json"],
        ],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("refuses a conflicting populated workspace before adoption", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[0] === "session") {
        return Effect.succeed(output("", 1));
      }
      if (input.args[0] === "new") {
        return Effect.succeed(output("", 1, 'workspace "project" already exists'));
      }
      return Effect.succeed(
        output(
          "",
          1,
          'workspace root "/repo/project" belongs to a different Git repository than workspace "project"',
        ),
      );
    });

    return Effect.gen(function* () {
      const result = yield* bindProjectWorktree;

      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.notice.summary, "zmux workspace root needs attention");
      assert.match(result.notice.detail, /belongs to a different Git repository/);
      assert.match(result.notice.detail, /zmux ls project/);
      assert.match(result.notice.detail, /zmux workspace set-root project <project-root>/);
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args[0]),
        ["session", "new", "session", "workspace"],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });
});
