import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  githubIssueSurface,
  migratePersistedRightPanelState,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";
const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});
describe("rightPanelStore", () => {
  it("upgrades saved Agents surfaces with neutral drill-down state", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "agents",
            surfaces: [{ id: "agents", kind: "agents" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "agents",
          surfaces: [
            {
              id: "agents",
              kind: "agents",
              selectedAgentId: null,
              rosterFocusAgentId: null,
            },
          ],
        },
      },
    });
  });
  it("opens one child directly and returns to its roster row", () => {
    useRightPanelStore.getState().openAgents(refA, { selectedAgentId: "agent-1" });
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "agents",
      kind: "agents",
      selectedAgentId: "agent-1",
      rosterFocusAgentId: null,
    });
    useRightPanelStore.getState().openAgents(refA, {
      selectedAgentId: null,
      rosterFocusAgentId: "agent-1",
    });
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "agents",
      kind: "agents",
      selectedAgentId: null,
      rosterFocusAgentId: "agent-1",
    });
  });
  it("normalizes persisted GitHub issue surfaces to their reference-keyed tab", () => {
    const id = githubIssueSurface({
      environmentId: "env-1",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 42,
    }).id;
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "github-issue",
            surfaces: [
              {
                id: "github-issue",
                kind: "github-issue",
                environmentId: "env-1",
                projectId: "project-a",
                repository: "pingdotgg/t3code",
                number: 42,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: id,
          surfaces: [
            {
              id,
              kind: "github-issue",
              environmentId: "env-1",
              projectId: "project-a",
              repository: "pingdotgg/t3code",
              number: 42,
            },
          ],
        },
      },
    });
  });
  it("drops malformed or environment-less persisted GitHub issue surfaces", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "github-issue",
            surfaces: [
              {
                id: "github-issue",
                kind: "github-issue",
                projectId: "project-a",
                repository: "pingdotgg/t3code",
                number: 42,
              },
              {
                id: "github-issue:malformed",
                kind: "github-issue",
                environmentId: "env-1",
                projectId: "",
                repository: "pingdotgg/t3code",
                number: 42,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: { "env-1:thread-A": { isOpen: false, activeSurfaceId: null, surfaces: [] } },
    });
  });
  it("keeps the Issues browser as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "github-issues");
    useRightPanelStore.getState().open(refA, "github-issues");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "github-issues",
      surfaces: [{ id: "github-issues", kind: "github-issues" }],
    });
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
  it("tracks one surface per GitHub issue", () => {
    const first = {
      environmentId: "env-1",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 7966,
    };
    const second = { ...first, number: 7967 };
    useRightPanelStore.getState().openGitHubIssue(refA, first);
    useRightPanelStore.getState().openGitHubIssue(refA, second);
    useRightPanelStore.getState().openGitHubIssue(refA, first);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      githubIssueSurface(first).id,
      githubIssueSurface(second).id,
    ]);
    expect(state.activeSurfaceId).toBe(githubIssueSurface(first).id);
  });
});
