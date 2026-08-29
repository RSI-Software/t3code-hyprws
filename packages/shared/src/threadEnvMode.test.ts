import { describe, expect, it } from "vite-plus/test";

import {
  fromWireThreadEnvModeFields,
  isDefaultThreadEnvModeSettled,
  resolveDefaultThreadEnvMode,
  toWireThreadEnvModeFields,
  toWireThreadEnvModeOverrideFields,
} from "./threadEnvMode.ts";

describe("resolveDefaultThreadEnvMode", () => {
  it("prefers the project setting over t3.json over the global default", () => {
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: "local",
        projectFile: "worktree",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: null,
        projectFile: "local",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: undefined,
        projectFile: null,
        globalDefault: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("isDefaultThreadEnvModeSettled", () => {
  it("settles on an explicit pick or project setting even while the file loads", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: "local",
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(true);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: "worktree",
        projectFilePending: true,
      }),
    ).toBe(true);
  });

  it("stays unsettled only while a consulted file read is pending", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(false);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: null,
        projectFilePending: false,
      }),
    ).toBe(true);
  });
});

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
