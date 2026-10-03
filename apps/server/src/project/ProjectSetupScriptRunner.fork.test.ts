import { describe, expect, it, vi } from "@effect/vitest";
import { type Project, ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  GENERATED_SETUP_COMMAND,
  layer as projectSetupScriptRunnerLayer,
  ProjectSetupScriptRunner,
  refreshPersistedSetupScript,
  refreshPersistedSetupScripts,
} from "./ProjectSetupScriptRunner.ts";
import * as ProjectService from "./ProjectService.ts";

const generatedSetupScripts = [
  {
    id: "setup-worktree",
    name: "Setup Worktree",
    command:
      "vp i && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
      "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
      "node apps/web/scripts/warm-dep-cache.ts",
  },
  {
    id: "setup-worktree-windows",
    name: "Setup Worktree (Windows)",
    command:
      'vp i && New-Item -ItemType SymbolicLink -Path .env -Target "$env:T3CODE_PROJECT_ROOT\\.env" -Force && ' +
      'New-Item -ItemType SymbolicLink -Path "infra\\relay\\.env" -Target "$env:T3CODE_PROJECT_ROOT\\infra\\relay\\.env" -Force && ' +
      "node apps\\web\\scripts\\warm-dep-cache.ts",
  },
] as const;

const legacyGeneratedScript: ProjectScript = {
  id: generatedSetupScripts[0].id,
  name: generatedSetupScripts[0].name,
  command: generatedSetupScripts[0].command,
  icon: "configure",
  runOnWorktreeCreate: true,
};

describe("persisted fork setup script refresh", () => {
  it("refreshes previously imported generated setup commands", () => {
    for (const generated of generatedSetupScripts) {
      expect(
        refreshPersistedSetupScript({
          ...generated,
          icon: "configure",
          runOnWorktreeCreate: true,
        }),
      ).toEqual({
        ...generated,
        name: "Setup Worktree",
        command: GENERATED_SETUP_COMMAND,
        icon: "configure",
        runOnWorktreeCreate: true,
      });
    }
  });

  it("refreshes the generated package-script wrapper used before dependencies exist", () => {
    expect(
      refreshPersistedSetupScript({
        ...legacyGeneratedScript,
        command: "vp run setup:worktree",
      }),
    ).toEqual({
      ...legacyGeneratedScript,
      command: GENERATED_SETUP_COMMAND,
    });
  });

  it("collapses the two exact generated platform entries into one", () => {
    const scripts: ProjectScript[] = generatedSetupScripts.map((script) => ({
      ...script,
      command: script.command.replace(/^vp i(?= &&)/u, "vp i --frozen-lockfile"),
      icon: "configure",
      runOnWorktreeCreate: true,
    }));

    expect(refreshPersistedSetupScripts(scripts)).toEqual([
      {
        ...scripts[0],
        name: "Setup Worktree",
        command: GENERATED_SETUP_COMMAND,
      },
    ]);
  });

  it("preserves intentional command and metadata customization", () => {
    const customCommand = {
      ...legacyGeneratedScript,
      command: "vp i && ./scripts/configure-worktree.sh",
    };
    const customMetadata = {
      ...legacyGeneratedScript,
      previewUrl: "http://localhost:5173",
      autoOpenPreview: true,
    };

    expect(refreshPersistedSetupScript(customCommand)).toBe(customCommand);
    expect(refreshPersistedSetupScript(customMetadata)).toBe(customMetadata);
  });
});

const SETUP_OUTCOME_MARKER =
  " && echo '[t3] setup script completed' || echo '[t3] setup script FAILED'";

const makeProject = (scripts: Project["scripts"]): Project => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const runningTerminal = (terminalId: string) => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/repo/worktrees/a",
  worktreePath: "/repo/worktrees/a",
  status: "running" as const,
  pid: 123,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: terminalId,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const testLayer = (
  project: Project,
  terminal: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
  settings = ServerSettings.layerTest(),
) =>
  projectSetupScriptRunnerLayer.pipe(
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed(
            workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
          ),
        getById: (projectId) =>
          Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
      }),
    ),
    Layer.provideMerge(Layer.mock(TerminalManager.TerminalManager)(terminal)),
    Layer.provide(settings),
  );

describe("fork setup outcome marker", () => {
  it.effect("runs the inherited machine setup action with the outcome marker", () => {
    const open = vi.fn(() => Effect.succeed(runningTerminal("setup-default-setup")));
    const write = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toMatchObject({ status: "started", scriptId: "default-setup" });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          COLORTERM: "",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        data: `npm install${SETUP_OUTCOME_MARKER}\r`,
      });
    }).pipe(
      Effect.provide(
        testLayer(
          makeProject([]),
          { open, write },
          ServerSettings.layerTest({
            defaultProjectScripts: [
              {
                id: "default-setup",
                name: "Setup",
                command: "npm install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          }),
        ),
      ),
    );
  });

  forkSupersedes({
    upstream:
      "apps/server/src/project/ProjectSetupScriptRunner.test.ts > resolves setup scripts through the standalone project service",
    reason:
      "the fork appends a completion or failure echo to an unobserved setup command, so the terminal receives the wrapped command",
    commit: "7fc74140d5c",
  });
  it.effect("opens the deterministic setup terminal and writes the marked command", () => {
    const open = vi.fn(() => Effect.succeed(runningTerminal("setup-setup")));
    const write = vi.fn(() => Effect.void);
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({
        status: "started",
        scriptId: "setup",
        scriptName: "Setup",
        scriptCommand: "bun install",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        async: true,
      });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          COLORTERM: "",
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-setup",
        data: `bun install${SETUP_OUTCOME_MARKER}\r`,
      });
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });
});
