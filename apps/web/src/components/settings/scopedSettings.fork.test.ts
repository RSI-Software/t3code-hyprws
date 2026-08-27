import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { planScopedSettingsPatch } from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

const environmentId = EnvironmentId.make("Server");
const projectId = ProjectId.make("project");
const member = {
  id: projectId,
  environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${environmentId}:/repo`,
  environmentLabel: "Server",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member],
  memberProjectRefs: [{ environmentId, projectId }],
  groupedProjectCount: 1,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: ["Server"],
};
// A stale `...Fork` sibling must not survive a new exact mode.
const withStaleFork = {
  environmentId,
  label: "Server",
  connection: { phase: "connected" as const },
  serverConfig: {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          defaultThreadEnvMode: "worktree" as const,
          defaultThreadEnvModeFork: "worktrunk" as const,
        },
      },
    },
    environment: { capabilities: { projectSettingsOverrides: true } },
  },
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], [withStaleFork]);

describe("scoped settings writes", () => {
  it("replaces the thread-mode pair wholesale at project scope", () => {
    const exact = planScopedSettingsPatch(project, [withStaleFork], {
      defaultThreadEnvMode: "worktree",
    });
    expect(exact.unavailableReason).toBeNull();
    expect(exact.serverWrites[0]!.patch!.projectSettingsOverrides![projectId]).toEqual({
      defaultThreadEnvMode: "worktree",
    });
    // A fork write carries the sibling alongside the wire slot.
    const forked = planScopedSettingsPatch(project, [withStaleFork], {
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
    });
    expect(forked.unavailableReason).toBeNull();
    expect(forked.serverWrites[0]!.patch!.projectSettingsOverrides![projectId]).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
    });
  });
});
