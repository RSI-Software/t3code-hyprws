import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizePullRequestProjectScopePatch,
  resolvePullRequestProjectScope,
  resolvePullRequestWindowScope,
} from "./pullRequestProjectScope.fork";

const environmentId = (value: string) => value as EnvironmentId;
const projectId = (value: string) => value as ProjectId;

const environments = [
  { environmentId: environmentId("env-1"), serverConfig: {} },
  { environmentId: environmentId("env-2"), serverConfig: null },
];

const allProjects = [
  { id: projectId("p-1"), environmentId: environmentId("env-1") },
  { id: projectId("p-2"), environmentId: environmentId("env-2") },
];

const ref = {
  environmentId: environmentId("env-1"),
  projectId: projectId("p-1"),
};

describe("pull-request project window scope", () => {
  it("resolves a project window to its own project and environment", () => {
    const scope = resolvePullRequestProjectScope({
      forcedProjectRef: ref,
      listScope: { kind: "project", projectRef: ref },
      search: {},
      environments,
      capableEnvironmentIds: [environmentId("env-1")],
      allProjects,
      projectsKnown: false,
    });
    expect(scope.scopedProjectId).toBe("p-1");
    expect(scope.scopedEnvironmentId).toBe("env-1");
    expect(scope.environmentIds).toEqual(["env-1"]);
    expect(scope.projects.map((project) => project.id)).toEqual(["p-1"]);
  });

  it("falls back to hub URL scope when the window reads all projects", () => {
    const scope = resolvePullRequestProjectScope({
      forcedProjectRef: ref,
      listScope: { kind: "all" },
      search: { projectId: projectId("p-2"), environmentId: environmentId("env-2") },
      environments,
      capableEnvironmentIds: [environmentId("env-1"), environmentId("env-2")],
      allProjects,
      projectsKnown: true,
    });
    expect(scope.scopedProjectId).toBeUndefined();
    expect(scope.scopedEnvironmentId).toBe("env-2");
  });

  it("resolves the hub window from URL scope alone", () => {
    const scope = resolvePullRequestProjectScope({
      forcedProjectRef: null,
      listScope: { kind: "all" },
      search: { projectId: projectId("p-2") },
      environments,
      capableEnvironmentIds: [environmentId("env-1"), environmentId("env-2")],
      allProjects,
      projectsKnown: true,
    });
    expect(scope.scopedProjectId).toBe("p-2");
    expect(scope.scopedProject?.environmentId).toBe("env-2");
  });

  it("keeps hub filters only outside a forced project window", () => {
    expect(
      resolvePullRequestWindowScope({ forcedProjectRef: null, listScope: { kind: "all" } }),
    ).toEqual({
      projectId: undefined,
      projectEnvironmentId: undefined,
      showHubScopeFilters: true,
    });
    expect(
      resolvePullRequestWindowScope({
        forcedProjectRef: ref,
        listScope: { kind: "project" },
      }),
    ).toEqual({
      projectId: "p-1",
      projectEnvironmentId: "env-1",
      showHubScopeFilters: false,
    });
    expect(
      resolvePullRequestWindowScope({ forcedProjectRef: ref, listScope: { kind: "all" } }),
    ).toEqual({
      projectId: undefined,
      projectEnvironmentId: undefined,
      showHubScopeFilters: false,
    });
  });

  it("strips hub project state from search patches inside a forced project window", () => {
    expect(normalizePullRequestProjectScopePatch({ projectId: "p-2", q: "x" }, ref)).toEqual({
      projectId: undefined,
      environmentId: undefined,
      q: "x",
    });
    expect(normalizePullRequestProjectScopePatch({ projectId: "p-2" }, null)).toEqual({
      projectId: "p-2",
    });
  });
});
