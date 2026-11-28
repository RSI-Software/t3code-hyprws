import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EnvMode,
  resolveEffectiveEnvMode,
  resolveBranchWorkspaceCwd,
  resolveLockedWorkspaceLabel,
  shouldShowGitControls,
} from "./BranchToolbar.logic";
import {
  EnvModeFork,
  resolveEnvModeLabelFork as resolveEnvModeLabel,
} from "./BranchToolbar.logic.fork";

const isEnvMode = Schema.is(EnvMode);
const isEnvModeFork = Schema.is(EnvModeFork);

describe("resolveLockedWorkspaceLabel", () => {
  it("names a worktrunk worktree", () => {
    expect(resolveLockedWorkspaceLabel("/repo/.t3/worktrees/feature-a", "worktrunk")).toBe(
      "feature-a",
    );
  });

  it("describes a worktrunk worktree that is still being created", () => {
    expect(resolveLockedWorkspaceLabel(null, "worktrunk")).toBe("New worktrunk");
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("keeps a server thread in worktrunk mode while its worktrunk worktree is being created", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
        preparingWorktree: true,
        preparingWorktrunk: true,
      }),
    ).toBe("worktrunk");
  });
});

describe("fork env mode label and schema", () => {
  it("resolves the worktrunk label through the fork resolver", () => {
    expect(resolveEnvModeLabel("worktree")).toBe("New worktree");
    expect(resolveEnvModeLabel("local")).toBe("Current checkout");
    expect(resolveEnvModeLabel("worktrunk")).toBe("New worktrunk");
  });

  it("extends the fork schema without replacing upstream EnvMode", () => {
    expect(isEnvMode("worktrunk")).toBe(false);
    for (const mode of EnvMode.literals) {
      expect(isEnvModeFork(mode)).toBe(true);
    }
    expect(isEnvModeFork("worktrunk")).toBe(true);
    expect(isEnvModeFork("new-worktrunk")).toBe(false);
  });
});
describe("shouldShowGitControls", () => {
  it("shows controls for the active Git workspace", () => {
    expect(
      shouldShowGitControls({
        activeWorkspaceIsGitRepo: true,
        hasActiveProject: true,
        hasActiveWorktree: false,
        projectCheckoutIsGitRepo: null,
      }),
    ).toBe(true);
  });

  it("shows recovery controls when the worktree is missing but the project checkout is valid", () => {
    expect(
      shouldShowGitControls({
        activeWorkspaceIsGitRepo: false,
        hasActiveProject: true,
        hasActiveWorktree: true,
        projectCheckoutIsGitRepo: true,
      }),
    ).toBe(true);
  });

  it("hides controls when neither workspace is a Git repository", () => {
    expect(
      shouldShowGitControls({
        activeWorkspaceIsGitRepo: false,
        hasActiveProject: true,
        hasActiveWorktree: true,
        projectCheckoutIsGitRepo: false,
      }),
    ).toBe(false);
  });
});

describe("resolveBranchWorkspaceCwd", () => {
  it("keeps using an available worktree", () => {
    expect(
      resolveBranchWorkspaceCwd({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        activeWorktreeIsRepo: true,
      }),
    ).toBe("/repo/.t3/worktrees/feature-a");
  });

  it("uses the project checkout when the thread worktree is unavailable", () => {
    expect(
      resolveBranchWorkspaceCwd({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/deleted",
        activeWorktreeIsRepo: false,
      }),
    ).toBe("/repo");
  });

  it("uses the project checkout for a local thread", () => {
    expect(
      resolveBranchWorkspaceCwd({
        activeProjectCwd: "/repo",
        activeWorktreePath: null,
        activeWorktreeIsRepo: null,
      }),
    ).toBe("/repo");
  });
});
