import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalCheckoutLaunch,
  terminalCheckoutLaunchIdentity,
} from "./terminalCheckoutLaunch.fork.ts";

describe("terminal checkout launch", () => {
  it("follows the selected checkout instead of stale launch and session state", () => {
    expect(
      resolveTerminalCheckoutLaunch({
        mode: "follow",
        projectCwd: "/repo",
        selectedWorktreePath: "/repo/worktrees/feature",
        requested: { cwd: "/repo", worktreePath: null },
        current: { cwd: "/repo", worktreePath: null },
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("keeps an explicit subdirectory when it belongs to the selected checkout", () => {
    expect(
      resolveTerminalCheckoutLaunch({
        mode: "follow",
        projectCwd: "/repo",
        selectedWorktreePath: "/repo/worktrees/feature",
        requested: {
          cwd: "/repo/worktrees/feature/packages/web",
          worktreePath: "/repo/worktrees/feature",
        },
        current: { cwd: "/repo", worktreePath: null },
      }),
    ).toEqual({
      cwd: "/repo/worktrees/feature/packages/web",
      worktreePath: "/repo/worktrees/feature",
    });
  });

  it("follows an explicit canonical checkout instead of the previous worktree", () => {
    expect(
      resolveTerminalCheckoutLaunch({
        mode: "follow",
        projectCwd: "/repo",
        selectedWorktreePath: null,
        requested: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
        current: {
          cwd: "/repo/worktrees/feature",
          worktreePath: "/repo/worktrees/feature",
        },
      }),
    ).toEqual({ cwd: "/repo", worktreePath: null });
  });

  it("keeps the current attachment location while pinned", () => {
    expect(
      resolveTerminalCheckoutLaunch({
        mode: "pin",
        projectCwd: "/repo",
        selectedWorktreePath: "/repo/worktrees/feature",
        requested: null,
        current: { cwd: "/repo", worktreePath: null },
      }),
    ).toEqual({ cwd: "/repo", worktreePath: null });
  });

  it("changes launch identity when Pin then Follow retries a checkout move", () => {
    const input = {
      projectCwd: "/repo",
      selectedWorktreePath: "/repo/worktrees/feature",
      requested: null,
      current: { cwd: "/repo", worktreePath: null },
    } as const;
    const pinned = resolveTerminalCheckoutLaunch({ ...input, mode: "pin" });
    const followed = resolveTerminalCheckoutLaunch({ ...input, mode: "follow" });

    expect(terminalCheckoutLaunchIdentity({ attachmentId: "terminal-1", ...pinned })).not.toBe(
      terminalCheckoutLaunchIdentity({ attachmentId: "terminal-1", ...followed }),
    );
  });
});
