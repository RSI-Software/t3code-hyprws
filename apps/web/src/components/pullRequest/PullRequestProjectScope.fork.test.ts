import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizePullRequestProjectScopePatch,
  resolvePullRequestProjectScope,
} from "./PullRequestProjectScope";

const environmentOne = "environment-1" as EnvironmentId;
const environmentTwo = "environment-2" as EnvironmentId;
const projectOne = "project-1" as ProjectId;
const projectTwo = "project-2" as ProjectId;
const forcedProjectRef = {
  environmentId: environmentOne,
  projectId: projectOne,
} as ScopedProjectRef;

const environments = [
  { environmentId: environmentOne, serverConfig: {} },
  { environmentId: environmentTwo, serverConfig: {} },
];
const projects = [
  { id: projectOne, environmentId: environmentOne },
  { id: projectTwo, environmentId: environmentTwo },
];

describe("pull request project scope", () => {
  it("uses the physical project and its environment in project mode", () => {
    const scope = resolvePullRequestProjectScope({
      forcedProjectRef,
      // The physical route identity wins even if an impossible stale caller scope disagrees.
      listScope: {
        kind: "project",
        projectRef: { environmentId: environmentTwo, projectId: projectTwo } as ScopedProjectRef,
      },
      search: { environmentId: environmentTwo, projectId: projectTwo },
      environments,
      capableEnvironmentIds: [environmentOne, environmentTwo],
      allProjects: projects,
      projectsKnown: true,
    });

    expect(scope.environmentIds).toEqual([environmentOne]);
    expect(scope.scopedEnvironmentId).toBe(environmentOne);
    expect(scope.scopedProjectId).toBe(projectOne);
    expect(scope.scopedProject).toBe(projects[0]);
    expect(scope.capabilityKnown).toBe(true);
  });

  it("keeps all capable environments in a project window's all-project mode", () => {
    const scope = resolvePullRequestProjectScope({
      forcedProjectRef,
      listScope: { kind: "all" },
      search: { projectId: projectTwo, scope: "all" },
      environments,
      capableEnvironmentIds: [environmentOne, environmentTwo],
      allProjects: projects,
      projectsKnown: true,
    });

    expect(scope.environmentIds).toEqual([environmentOne, environmentTwo]);
    expect(scope.projects).toEqual(projects);
    expect(scope.scopedProjectId).toBeUndefined();
    expect(scope.scopedProject).toBeUndefined();
  });

  it("waits for the scoped remote environment without reading another server", () => {
    const scope = resolvePullRequestProjectScope({
      forcedProjectRef,
      listScope: { kind: "project", projectRef: forcedProjectRef },
      search: {},
      environments: [
        { environmentId: environmentOne, serverConfig: null },
        { environmentId: environmentTwo, serverConfig: {} },
      ],
      capableEnvironmentIds: [environmentTwo],
      allProjects: projects,
      projectsKnown: false,
    });

    expect(scope.environmentIds).toEqual([]);
    expect(scope.capabilityKnown).toBe(false);
    expect(scope.scopedProjectId).toBe(projectOne);
  });

  it("removes hub scope fields while preserving upstream search state", () => {
    expect(
      normalizePullRequestProjectScopePatch(
        {
          q: "author:octocat",
          environmentId: environmentTwo,
          projectId: projectTwo,
        },
        forcedProjectRef,
      ),
    ).toEqual({
      q: "author:octocat",
      environmentId: undefined,
      projectId: undefined,
    });
  });
});
