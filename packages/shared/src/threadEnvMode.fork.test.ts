import { describe, expect, it } from "vite-plus/test";
import type { StoredThreadEnvMode } from "./threadEnvMode.fork.ts";
import {
  fromWireThreadEnvModeFields,
  toWireThreadEnvModeFields,
  toWireThreadEnvModeOverrideFields,
} from "./threadEnvMode.fork.ts";
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

describe("project override thread env mode path", () => {
  const writeOverride = (mode: StoredThreadEnvMode | null) =>
    toWireThreadEnvModeOverrideFields(mode);

  it("a project override of worktrunk survives write then read", () => {
    expect(fromWireThreadEnvModeFields(writeOverride("worktrunk"))).toBe("worktrunk");
  });

  it("sends a worktrunk override on the wire as worktree plus the sibling", () => {
    expect(writeOverride("worktrunk")).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
    });
  });

  it("a worktree override adds no fork sibling", () => {
    expect(writeOverride("worktree")).toEqual({ defaultThreadEnvMode: "worktree" });
  });

  it("clearing the override round-trips as null", () => {
    expect(writeOverride(null)).toEqual({ defaultThreadEnvMode: null });
    expect(fromWireThreadEnvModeFields(writeOverride(null))).toBeNull();
  });

  it("an override payload with no sibling decodes to the wire value", () => {
    expect(
      fromWireThreadEnvModeFields({
        defaultThreadEnvMode: "worktree",
        defaultThreadEnvModeFork: undefined,
      }),
    ).toBe("worktree");
  });
});
