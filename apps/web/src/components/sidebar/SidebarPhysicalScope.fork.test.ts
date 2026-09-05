import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { reorderProjectThreads, type UiState } from "../../uiStateStore";
import { orderThreadsByProjectPreference, searchSidebarThreadsByTitle } from "../Sidebar.logic";
import {
  filterSidebarProjects,
  filterSidebarThreads,
  resolveSidebarPhysicalScope,
  setSidebarLogicalScope,
} from "./SidebarPhysicalScope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("shared");
const target = { environmentId: remote, projectId };
const projects: Project[] = [local, remote].map((environmentId) => ({
  environmentId,
  id: projectId,
  title: "repo",
  workspaceRoot: "/work/repo",
  repositoryIdentity: {
    canonicalKey: "github.com/example/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/repo.git",
    },
    provider: "github",
    owner: "example",
    name: "repo",
    displayName: "repo",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
}));
const groupsFor = (items: readonly Project[]) =>
  buildSidebarProjectSnapshots({
    projects: items,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: local,
    resolveEnvironmentLabel: (id) => id,
  });

describe("physical sidebar boundary", () => {
  it("narrows physical projects before upstream repository grouping without changing hub groups", () => {
    expect(filterSidebarProjects(projects, null)).toBe(projects);
    const hub = groupsFor(projects);
    expect(hub).toHaveLength(1);
    expect(hub[0]?.memberProjectRefs).toHaveLength(2);
    const physical = groupsFor(filterSidebarProjects(projects, target));
    expect(physical).toHaveLength(1);
    expect(physical[0]?.memberProjectRefs).toEqual([target]);
    const scope = resolveSidebarPhysicalScope({
      forcedProjectRef: target,
      logicalScopeKey: "other",
      projectGroups: physical,
    });
    expect(scope.projectGroup).toBe(physical[0]);
    expect(scope.effectiveScopeKey).toBe(physical[0]?.projectKey);
    expect([...scope.projectKeys!]).toEqual(["remote:shared"]);
  });

  it("keeps the exact physical key while metadata is absent and excludes other drafts and search hits", () => {
    const scope = resolveSidebarPhysicalScope({
      forcedProjectRef: target,
      logicalScopeKey: "saved-hub-scope",
      projectGroups: [],
    });
    expect(scope.projectGroup).toBeNull();
    expect(scope.effectiveScopeKey).toBeNull();
    expect([...scope.projectKeys!]).toEqual(["remote:shared"]);
    const rows = [
      { ...target, id: "target", title: "matching thread" },
      { environmentId: local, projectId, id: "other-env", title: "matching thread" },
      {
        environmentId: remote,
        projectId: ProjectId.make("other"),
        id: "other-project",
        title: "matching thread",
      },
    ];
    // The modern sidebar's draft and thread selectors consume this same key set.
    const scoped = rows.filter((row) =>
      scope.projectKeys?.has(`${row.environmentId}:${row.projectId}`),
    );
    expect(searchSidebarThreadsByTitle(scoped, "matching").map((row) => row.id)).toEqual([
      "target",
    ]);
    expect(filterSidebarThreads(rows, target)).toEqual(scoped);
    expect(filterSidebarThreads(rows, null)).toBe(rows);
    expect(searchSidebarThreadsByTitle(rows, "matching")).toHaveLength(3);
  });

  it("keeps upstream logical scope and setter ownership in the hub", () => {
    const groups = groupsFor(projects);
    const key = groups[0]!.projectKey;
    const hub = resolveSidebarPhysicalScope({
      forcedProjectRef: null,
      logicalScopeKey: key,
      projectGroups: groups,
    });
    expect(hub.projectGroup).toBe(groups[0]);
    expect([...hub.projectKeys!]).toEqual(["local:shared", "remote:shared"]);
    const missing = resolveSidebarPhysicalScope({
      forcedProjectRef: null,
      logicalScopeKey: key,
      projectGroups: [],
    });
    expect(missing.effectiveScopeKey).toBe(key);
    const writes: Array<string | null> = [];
    setSidebarLogicalScope(target, null, (value) => writes.push(value));
    expect(writes).toEqual([]);
    setSidebarLogicalScope(null, key, (value) => writes.push(value));
    setSidebarLogicalScope(null, null, (value) => writes.push(value));
    expect(writes).toEqual([key, null]);
    expect(
      resolveSidebarPhysicalScope({
        forcedProjectRef: null,
        logicalScopeKey: null,
        projectGroups: groups,
      }).projectKeys,
    ).toBeNull();
  });

  it("preserves project-specific manual order across serialization without touching another project", () => {
    const state: UiState = {
      projectExpandedById: {},
      projectOrder: [],
      threadOrderByProject: { "local:shared": ["local:b", "local:a"] },
      threadGroupsByProject: {},
      threadLastVisitedAtById: {},
      threadChangedFilesExpandedById: {},
      defaultAdvertisedEndpointKey: null,
    };
    const changed = reorderProjectThreads(
      state,
      "remote:shared",
      ["remote:a", "remote:b"],
      "remote:b",
      "remote:a",
    );
    const restored: UiState = JSON.parse(JSON.stringify(changed));
    expect(restored.threadOrderByProject["local:shared"]).toEqual(
      state.threadOrderByProject["local:shared"],
    );
    const threads = [
      { ...target, id: "remote:new" },
      { ...target, id: "remote:a" },
      { ...target, id: "remote:b" },
      { environmentId: local, projectId, id: "local:a" },
    ];
    const scoped = filterSidebarThreads(threads, target);
    const ordered = orderThreadsByProjectPreference({
      threads: scoped,
      preferredIdsByProject: restored.threadOrderByProject,
      getId: (thread) => thread.id,
      getProjectKey: (thread) => `${thread.environmentId}:${thread.projectId}`,
    });
    expect(ordered.map((thread) => thread.id)).toEqual(["remote:b", "remote:a", "remote:new"]);
    expect(scoped.map((thread) => thread.id)).toEqual(["remote:new", "remote:a", "remote:b"]);
  });
});
