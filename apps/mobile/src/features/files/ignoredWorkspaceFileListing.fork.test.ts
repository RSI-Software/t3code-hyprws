import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));

import { resolveIgnoredWorkspaceFileListing } from "./ignoredWorkspaceFileListing";

describe("ignored workspace file listing boundary", () => {
  it("keeps the ordinary workspace listing while the preference is unset", () => {
    expect(resolveIgnoredWorkspaceFileListing("/workspace", undefined)).toEqual({
      cwd: "/workspace",
    });
  });

  it("reveals ignored paths only while the device preference is enabled", () => {
    expect(resolveIgnoredWorkspaceFileListing("/workspace", true)).toEqual({
      cwd: "/workspace",
      includeIgnored: true,
    });
    expect(resolveIgnoredWorkspaceFileListing("/workspace", false)).toEqual({
      cwd: "/workspace",
    });
  });

  it("preserves local and remote workspace roots without interpreting them", () => {
    expect(resolveIgnoredWorkspaceFileListing("/home/dev/repository", true)).toEqual({
      cwd: "/home/dev/repository",
      includeIgnored: true,
    });
    expect(resolveIgnoredWorkspaceFileListing("C:\\Users\\dev\\repository", true)).toEqual({
      cwd: "C:\\Users\\dev\\repository",
      includeIgnored: true,
    });
  });

  it("does not issue a listing before the route resolves a workspace", () => {
    expect(resolveIgnoredWorkspaceFileListing(null, true)).toBeNull();
  });
});
