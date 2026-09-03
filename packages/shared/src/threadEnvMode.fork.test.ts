import { describe, expect, it } from "vite-plus/test";
import {
  fromWireThreadEnvModeFields,
  toWireThreadEnvModeFields,
  toWireThreadEnvModeOverrideFields,
} from "./threadEnvMode.ts";
describe("thread env mode wire fields", () => {
  it("sends worktrunk as worktree and carries the exact mode alongside", () => {
    expect(toWireThreadEnvModeFields("worktrunk")).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
    });
  });
  it("omits the fork sibling when the wire value is already exact", () => {
    expect(toWireThreadEnvModeFields("worktree")).toEqual({ defaultThreadEnvMode: "worktree" });
    expect(toWireThreadEnvModeFields("local")).toEqual({ defaultThreadEnvMode: "local" });
  });
  it("keeps a cleared override as null rather than a mode", () => {
    expect(toWireThreadEnvModeOverrideFields(null)).toEqual({ defaultThreadEnvMode: null });
  });
  it("round trips every mode", () => {
    for (const mode of ["local", "worktree", "worktrunk"] as const) {
      expect(fromWireThreadEnvModeFields(toWireThreadEnvModeFields(mode))).toBe(mode);
    }
  });
  it("reads a payload from a server that predates the fork sibling", () => {
    expect(fromWireThreadEnvModeFields({ defaultThreadEnvMode: "worktree" })).toBe("worktree");
    expect(fromWireThreadEnvModeFields({ defaultThreadEnvMode: null })).toBeNull();
    expect(fromWireThreadEnvModeFields({})).toBeUndefined();
  });
});
