import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvMode, resolveEnvModeLabel, resolveLockedWorkspaceLabel } from "./BranchToolbar.logic";
import { resolveForkEnvModeLabel } from "./BranchToolbar.logic.fork";

describe("resolveLockedWorkspaceLabel", () => {
  it("names a worktrunk worktree", () => {
    expect(resolveLockedWorkspaceLabel("/repo/.t3/worktrees/feature-a", true)).toBe("Worktrunk");
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
