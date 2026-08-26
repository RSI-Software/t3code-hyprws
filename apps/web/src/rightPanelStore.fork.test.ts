import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { forkSupersedes } from "../../../scripts/lib/fork-supersedes.ts";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  // The fork keeps the standalone explorer beside open files while upstream
  // replaces it (commit `cb6fe69b6d`).
  forkSupersedes({
    upstream:
      "apps/web/src/rightPanelStore.test.ts > replaces the standalone explorer with peer file surfaces",
    reason:
      "the fork keeps the standalone explorer beside peer file surfaces while upstream replaces it",
    commit: "cb6fe69b6d",
  });
  it("keeps the standalone explorer beside peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        { id: "files", kind: "files" },
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 2,
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });

  it("returns to the explorer when the last file surface closes", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");
    useRightPanelStore.getState().closeSurface(refA, "file:README.md");
    useRightPanelStore.getState().closeSurface(refA, "file:src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
  });

  it("deselects the open file by activating the explorer surface", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().activateSurface(refA, "files");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [
        { id: "files", kind: "files" },
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
  });
});
