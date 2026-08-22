import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";

const { executeAtomQueryMock } = vi.hoisted(() => ({
  executeAtomQueryMock: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: () => executeAtomQueryMock(),
}));

vi.mock("~/components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: () => ({}),
  resolveProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _workspaceRoot: string,
    _fileName: string,
    value: unknown,
  ) => value,
}));

vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { readT3ProjectFileDefaultThreadEnvMode } from "./t3ProjectFileDefaults";

const environmentId = "env-1" as EnvironmentId;

describe("readT3ProjectFileDefaultThreadEnvMode", () => {
  beforeEach(() => {
    executeAtomQueryMock.mockReset();
  });

  it("reads the project file default when the query settles", async () => {
    executeAtomQueryMock.mockResolvedValue({
      _tag: "Success",
      value: { contents: JSON.stringify({ defaultThreadEnvMode: "worktree" }), truncated: false },
    });

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo")).resolves.toBe(
      "worktree",
    );
  });

  // An unreachable environment leaves the file query pending forever. New-thread
  // start must fall back to the global default instead of hanging, or the route
  // that awaits it renders nothing at all.
  it("falls back to null when the query never settles", async () => {
    executeAtomQueryMock.mockReturnValue(new Promise(() => {}));

    await expect(readT3ProjectFileDefaultThreadEnvMode(environmentId, "/repo", 5)).resolves.toBe(
      null,
    );
  });
});
