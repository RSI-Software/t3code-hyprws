import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  EnvMode,
  resolveEffectiveEnvMode,
  resolveEnvModeLabel,
  resolveBranchWorkspaceCwd,
  resolveLockedWorkspaceLabel,
  shouldShowGitControls,
} from "./BranchToolbar.logic";
import {
  applyUnusableWorktreeRebindFork,
  resolveForkEnvModeLabel,
  resolveUnusableWorktreeRebindFork,
} from "./BranchToolbar.logic.fork";

describe("resolveLockedWorkspaceLabel", () => {
  it("names a worktrunk worktree", () => {
    expect(resolveLockedWorkspaceLabel("/repo/.t3/worktrees/feature-a", "worktrunk", true)).toBe(
      "Worktrunk",
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
    expect(resolveForkEnvModeLabel("worktrunk")).toBe("New worktrunk");
    expect(resolveForkEnvModeLabel("worktree")).toBeNull();
    expect(resolveForkEnvModeLabel("local")).toBeNull();
    expect(resolveEnvModeLabel("worktrunk")).toBe("New worktrunk");
  });

  it("keeps EnvMode on the fork enum schema, worktrunk included", () => {
    expect(Schema.is(EnvMode)("worktrunk")).toBe(true);
    expect(Schema.is(EnvMode)("local")).toBe(true);
    expect(Schema.is(EnvMode)("worktree")).toBe(true);
    expect(Schema.is(EnvMode)("new-worktrunk")).toBe(false);
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

describe("branch pick on a removed worktree", () => {
  const base = {
    hasServerThread: true,
    activeProjectCwd: "/repo",
    threadWorktreePath: "/repo/.t3/worktrees/deleted",
    usableActiveWorktreePath: null,
  };
  const ref = { name: "origin/feature", isRemote: true, worktreePath: null };

  it("rebinds to the project checkout without a checkout move or ref switch", () => {
    const rebind = resolveUnusableWorktreeRebindFork({ ...base, refName: ref });
    expect(rebind).toEqual({ branch: "feature", worktreePath: null });
    const calls: Array<string> = [];
    applyUnusableWorktreeRebindFork(rebind!, {
      environmentId: "env" as never,
      threadId: "thread" as never,
      hasSession: true,
      stopThreadSession: () => calls.push("stop"),
      updateThreadMetadata: ({ input }) =>
        calls.push(`rebind ${input.branch} ${input.worktreePath}`),
      onDone: () => calls.push("done"),
    });
    expect(calls).toEqual(["stop", "rebind feature null", "done"]);
  });

  it("rebinds to the branch's own worktree when it has one", () => {
    expect(
      resolveUnusableWorktreeRebindFork({
        ...base,
        refName: { name: "other", isRemote: false, worktreePath: "/repo/.t3/worktrees/other" },
      }),
    ).toEqual({ branch: "other", worktreePath: "/repo/.t3/worktrees/other" });
  });

  it("leaves a usable worktree and a draft to the upstream selection", () => {
    const usable = { ...base, usableActiveWorktreePath: base.threadWorktreePath };
    expect(resolveUnusableWorktreeRebindFork({ ...usable, refName: ref })).toBeNull();
    expect(
      resolveUnusableWorktreeRebindFork({ ...base, hasServerThread: false, refName: ref }),
    ).toBeNull();
  });
});
