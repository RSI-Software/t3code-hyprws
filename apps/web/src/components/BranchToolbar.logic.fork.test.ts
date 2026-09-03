import { describe, expect, it } from "vite-plus/test";

import { resolveLockedWorkspaceLabel } from "./BranchToolbar.logic";

describe("resolveLockedWorkspaceLabel", () => {
  it("names a worktrunk worktree", () => {
    expect(resolveLockedWorkspaceLabel("/repo/.t3/worktrees/feature-a", true)).toBe("Worktrunk");
  });
});
