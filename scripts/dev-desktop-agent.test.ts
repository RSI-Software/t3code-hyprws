import { assert, describe, it } from "@effect/vitest";

import { parseDesktopAgentCommand } from "./dev-desktop-agent.ts";
import {
  allocateDesktopAgentPort,
  captureDesktopAgentWorkspace,
  desktopAgentDevRunnerArgs,
  desktopAgentInstanceHash,
  desktopAgentPortCandidate,
  desktopAgentUserDataDirectory,
  parseDesktopAgentHyprlandClients,
  parseDesktopAgentWorkspaceSelector,
  resolveAgentTargetWorkspace,
  resolveInvokingT3Workspace,
  selectDesktopAgentWorkspaceSelector,
  withoutInheritedDevRunnerEnv,
} from "./lib/dev-desktop-agent.ts";

describe("desktop agent launcher", () => {
  it("parses the run, dry-run, url, and help contracts", () => {
    assert.deepStrictEqual(parseDesktopAgentCommand(["run"]), {
      kind: "run",
      dryRun: false,
      workspace: undefined,
      homeDir: undefined,
    });
    assert.deepStrictEqual(parseDesktopAgentCommand(["run", "--dry-run"]), {
      kind: "run",
      dryRun: true,
      workspace: undefined,
      homeDir: undefined,
    });
    assert.deepStrictEqual(parseDesktopAgentCommand(["run", "--workspace", "-1"]), {
      kind: "run",
      dryRun: false,
      workspace: "-1",
      homeDir: undefined,
    });
    assert.deepStrictEqual(parseDesktopAgentCommand(["run", "--workspace=none"]), {
      kind: "run",
      dryRun: false,
      workspace: "none",
      homeDir: undefined,
    });
    assert.deepStrictEqual(
      parseDesktopAgentCommand(["run", "--workspace=+1", "--home-dir", "/worktree/.t3"]),
      {
        kind: "run",
        dryRun: false,
        workspace: "+1",
        homeDir: "/worktree/.t3",
      },
    );
    assert.deepStrictEqual(parseDesktopAgentCommand(["url"]), { kind: "url" });
    assert.deepStrictEqual(parseDesktopAgentCommand(["--help"]), { kind: "help" });
    assert.throws(() => parseDesktopAgentCommand([]), /missing command/u);
    assert.throws(() => parseDesktopAgentCommand(["run", "--wat"]), /unknown argument/u);
    assert.throws(() => parseDesktopAgentCommand(["run", "--workspace"]), /requires a value/u);
    assert.throws(
      () => parseDesktopAgentCommand(["run", "--workspace", "-1", "--workspace=2"]),
      /only once/u,
    );
    assert.throws(
      () => parseDesktopAgentCommand(["run", "--workspace", "m-1"]),
      /invalid --workspace value/u,
    );
    assert.throws(() => parseDesktopAgentCommand(["run", "--home-dir"]), /non-empty path/u);
    assert.throws(
      () => parseDesktopAgentCommand(["run", "--home-dir=.t3", "--home-dir", ".other"]),
      /only once/u,
    );
  });

  it("defaults to compositor placement and accepts personal workspace selectors", () => {
    assert.deepStrictEqual(parseDesktopAgentWorkspaceSelector(undefined), { kind: "default" });
    assert.deepStrictEqual(parseDesktopAgentWorkspaceSelector("none"), { kind: "default" });
    assert.deepStrictEqual(parseDesktopAgentWorkspaceSelector("-1"), {
      kind: "relative",
      offset: -1,
    });
    assert.deepStrictEqual(parseDesktopAgentWorkspaceSelector("+1"), {
      kind: "relative",
      offset: 1,
    });
    assert.deepStrictEqual(parseDesktopAgentWorkspaceSelector("7"), {
      kind: "numbered",
      workspace: { id: 7, name: "7" },
    });
    assert.throws(() => parseDesktopAgentWorkspaceSelector("-2"), /invalid.+selector/u);
    assert.throws(() => parseDesktopAgentWorkspaceSelector("+2"), /invalid.+selector/u);
    assert.throws(() => parseDesktopAgentWorkspaceSelector("m-1"), /invalid.+selector/u);
    assert.throws(() => parseDesktopAgentWorkspaceSelector("0"), /invalid.+selector/u);
  });

  it("lets the CLI override the saved repository workspace selector", () => {
    assert.deepStrictEqual(
      selectDesktopAgentWorkspaceSelector(undefined, {
        T3CODE_DESKTOP_AGENT_WORKSPACE: "+1",
      }),
      { kind: "relative", offset: 1 },
    );
    assert.deepStrictEqual(
      selectDesktopAgentWorkspaceSelector("none", {
        T3CODE_DESKTOP_AGENT_WORKSPACE: "+1",
      }),
      { kind: "default" },
    );
  });

  it("targets a numbered workspace immediately beside the invoking app", () => {
    assert.deepStrictEqual(resolveAgentTargetWorkspace({ id: 7, name: "7" }, -1), {
      id: 6,
      name: "6",
    });
    assert.deepStrictEqual(resolveAgentTargetWorkspace({ id: 7, name: "7" }, 1), {
      id: 8,
      name: "8",
    });
    assert.throws(
      () => resolveAgentTargetWorkspace({ id: -99, name: "special:scratch" }, -1),
      /numbered Hyprland workspace/u,
    );
    assert.throws(
      () => resolveAgentTargetWorkspace({ id: 4, name: "code" }, 1),
      /numbered Hyprland workspace/u,
    );
    assert.throws(
      () => resolveAgentTargetWorkspace({ id: 1, name: "1" }, -1),
      /no valid previous/u,
    );
  });

  it("captures a relative origin from the invoking project window and verifies absolute placement", () => {
    let clientsCalls = 0;
    let activeWorkspaceCalls = 0;
    const dependencies = {
      readActiveWorkspace: () => {
        activeWorkspaceCalls += 1;
        return { id: 2, name: "2" };
      },
      readClients: () => {
        clientsCalls += 1;
        return [
          {
            pid: 200,
            initialTitle: "project-a",
            workspace: { id: 7, name: "7" },
            mapped: true,
            hidden: false,
          },
          {
            pid: 999,
            initialTitle: "focused-other-app",
            workspace: { id: 12, name: "12" },
            mapped: true,
            hidden: false,
          },
        ];
      },
      selfPid: 500,
      readParent: (pid: number) => (pid === 500 ? 200 : 1),
    };
    assert.deepStrictEqual(
      captureDesktopAgentWorkspace("+1", { T3CODE_PROJECT_ID: "project-a" }, dependencies),
      { origin: { id: 7, name: "7" }, target: { id: 8, name: "8" } },
    );
    assert.equal(clientsCalls, 1);
    assert.equal(activeWorkspaceCalls, 0);

    assert.deepStrictEqual(captureDesktopAgentWorkspace("9", {}, dependencies), {
      origin: null,
      target: { id: 9, name: "9" },
    });
    assert.equal(clientsCalls, 1);
    assert.equal(activeWorkspaceCalls, 1);
    assert.deepStrictEqual(captureDesktopAgentWorkspace("none", {}, dependencies), {
      origin: null,
      target: null,
    });
    assert.equal(clientsCalls, 1);
    assert.equal(activeWorkspaceCalls, 1);
    assert.throws(
      () =>
        captureDesktopAgentWorkspace(
          "9",
          {},
          {
            ...dependencies,
            readActiveWorkspace: () => {
              throw new Error("no compositor");
            },
          },
        ),
      /no compositor/u,
    );
  });

  it("uses a sole owned window when its map-time title replaced the project identity", () => {
    const client = {
      pid: 200,
      initialTitle: "t3code-dev-agent-test",
      workspace: { id: 7, name: "7" },
      mapped: true,
      hidden: false,
    } as const;
    const input = {
      clients: [client],
      selfPid: 500,
      readParent: (pid: number) => (pid === 500 ? 200 : 1),
    };

    assert.deepStrictEqual(resolveInvokingT3Workspace({ ...input, projectId: "project-a" }), {
      id: 7,
      name: "7",
    });
    assert.deepStrictEqual(
      resolveInvokingT3Workspace({
        ...input,
        projectId: "project-a",
        clients: [
          client,
          {
            ...client,
            initialTitle: "project-a",
            workspace: { id: 8, name: "8" },
          },
        ],
      }),
      { id: 8, name: "8" },
    );
  });

  it("fails rather than guessing when scoped project origins are absent or ambiguous", () => {
    const client = {
      pid: 200,
      initialTitle: "project-a",
      workspace: { id: 7, name: "7" },
      mapped: true,
      hidden: false,
    } as const;
    const input = {
      clients: [client],
      selfPid: 500,
      readParent: (pid: number) => (pid === 500 ? 200 : 1),
    };

    assert.throws(
      () =>
        resolveInvokingT3Workspace({
          ...input,
          projectId: "project-b",
          clients: [client, { ...client, initialTitle: "project-c" }],
        }),
      /ambiguous.+no owned window matches project project-b.+2 visible windows/u,
    );
    assert.throws(
      () =>
        resolveInvokingT3Workspace({
          ...input,
          projectId: "project-a",
          clients: [client, { ...client, workspace: { id: 8, name: "8" } }],
        }),
      /ambiguous.+2 visible windows/u,
    );
    assert.throws(
      () =>
        resolveInvokingT3Workspace({
          ...input,
          projectId: "project-a",
          clients: [{ ...client, workspace: { id: -99, name: "special:scratch" } }],
        }),
      /no visible window/u,
    );
  });

  it("supports one ancestor-owned terminal window without project identity", () => {
    const base = {
      projectId: undefined,
      selfPid: 500,
      readParent: (pid: number) => (pid === 500 ? 300 : pid === 300 ? 200 : 1),
    };
    const terminal = {
      pid: 200,
      initialTitle: "shell",
      workspace: { id: 6, name: "6" },
      mapped: true,
      hidden: false,
    } as const;
    assert.deepStrictEqual(resolveInvokingT3Workspace({ ...base, clients: [terminal] }), {
      id: 6,
      name: "6",
    });
    assert.throws(
      () =>
        resolveInvokingT3Workspace({
          ...base,
          clients: [terminal, { ...terminal, initialTitle: "second" }],
        }),
      /ambiguous.+T3CODE_PROJECT_ID is unset/u,
    );
    assert.throws(
      () => resolveInvokingT3Workspace({ ...base, clients: [{ ...terminal, pid: 999 }] }),
      /could not find.+owned/u,
    );
  });

  it("parses only usable Hyprland client identity fields", () => {
    assert.deepStrictEqual(
      parseDesktopAgentHyprlandClients(
        JSON.stringify([
          {
            pid: 200,
            initialTitle: "project-a",
            workspace: { id: 7, name: "7" },
            mapped: true,
            hidden: false,
          },
          { pid: "bad", initialTitle: "ignored", workspace: { id: 8, name: "8" } },
        ]),
      ),
      [
        {
          pid: 200,
          initialTitle: "project-a",
          workspace: { id: 7, name: "7" },
          mapped: true,
          hidden: false,
        },
      ],
    );
    assert.throws(() => parseDesktopAgentHyprlandClients("not-json"), /invalid JSON/u);
  });

  it("forwards only an explicit home override to the existing dev runner", () => {
    assert.deepStrictEqual(desktopAgentDevRunnerArgs(undefined), ["run", "dev:desktop"]);
    assert.deepStrictEqual(desktopAgentDevRunnerArgs("/worktree/.t3"), [
      "run",
      "dev:desktop",
      "--home-dir",
      "/worktree/.t3",
    ]);
    assert.deepStrictEqual(
      desktopAgentDevRunnerArgs("/worktree/.t3", ["--port", "3774", "--host", "127.0.0.1"]),
      [
        "run",
        "dev:desktop",
        "--home-dir",
        "/worktree/.t3",
        "--port",
        "3774",
        "--host",
        "127.0.0.1",
      ],
    );
    assert.equal(
      desktopAgentUserDataDirectory("/worktree", "/worktree/.t3"),
      "/worktree/.t3/electron",
    );
    assert.equal(desktopAgentUserDataDirectory("/worktree", ".state"), "/worktree/.state/electron");
    assert.isUndefined(desktopAgentUserDataDirectory("/worktree", undefined));
  });

  it("derives stable instance hashes and port candidates", () => {
    const hash = desktopAgentInstanceHash("/repo/worktree-a");
    assert.equal(hash, desktopAgentInstanceHash("/repo/worktree-a"));
    assert.notEqual(hash, desktopAgentInstanceHash("/repo/worktree-b"));
    assert.match(hash, /^[0-9a-f]{12}$/u);
    const candidate = desktopAgentPortCandidate(hash);
    assert.isAtLeast(candidate, 9223);
    assert.isBelow(candidate, 9273);
  });

  it("does not inherit the parent T3 dev runner's instance configuration", () => {
    const output = withoutInheritedDevRunnerEnv({
      PATH: "/usr/bin",
      T3CODE_DESKTOP_AGENT_WORKSPACE: "-1",
      T3CODE_PORT: "3773",
      PORT: "5173",
      T3CODE_HOME: "/home/user/.t3",
      T3CODE_PORT_OFFSET: "4",
      T3CODE_DEV_INSTANCE: "stable",
      T3CODE_DESKTOP_USER_DATA_DIR: "/shared/profile",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      VITE_HTTP_URL: "http://127.0.0.1:3773",
      VITE_WS_URL: "ws://127.0.0.1:3773",
    });

    assert.deepStrictEqual(output, {
      PATH: "/usr/bin",
      T3CODE_DESKTOP_AGENT_WORKSPACE: "-1",
    });
  });

  it("scans past registered and externally bound ports", async () => {
    const checked: number[] = [];
    const port = await allocateDesktopAgentPort({
      hash: "000000abcdef",
      base: 9223,
      spread: 50,
      scanExtra: 5,
      claimedPorts: new Set([9223]),
      isBindable: async (candidate) => {
        checked.push(candidate);
        return candidate >= 9226;
      },
    });

    assert.equal(port, 9226);
    assert.deepStrictEqual(checked, [9224, 9225, 9226]);
  });

  it("fails when the bounded debug-port range is exhausted", async () => {
    let failure: unknown;
    try {
      await allocateDesktopAgentPort({
        hash: "000000abcdef",
        base: 9223,
        spread: 1,
        scanExtra: 1,
        claimedPorts: new Set(),
        isBindable: async () => false,
      });
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, Error);
    assert.match((failure as Error).message, /no free desktop debugging port/u);
  });
});
