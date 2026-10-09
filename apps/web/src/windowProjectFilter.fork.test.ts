import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";

import {
  filterProjectsToWindow,
  windowLandingProjects,
  windowListProjects,
} from "./windowProjectFilter.fork";

const project = (environment: string, id: string) => ({
  environmentId: EnvironmentId.make(environment),
  id: ProjectId.make(id),
});

describe("filterProjectsToWindow", () => {
  const projects = [project("env-a", "one"), project("env-a", "two"), project("env-b", "one")];

  it("keeps every project while the window shows all", () => {
    expect(filterProjectsToWindow(projects, null)).toBe(projects);
  });

  it("keeps only the projects the window's filter shows, per environment", () => {
    const keys = new Set([
      scopedProjectKey(scopeProjectRef(EnvironmentId.make("env-b"), ProjectId.make("one"))),
    ]);
    expect(filterProjectsToWindow(projects, keys)).toEqual([project("env-b", "one")]);
  });
});

const keyOf = (environment: string, id: string) =>
  scopedProjectKey(scopeProjectRef(EnvironmentId.make(environment), ProjectId.make(id)));

describe("windowListProjects", () => {
  const projects = [
    project("env-a", "solar"),
    project("env-a", "quarry"),
    project("env-b", "vone"),
  ];
  const solarOnly = new Set([keyOf("env-a", "solar")]);

  it("adds a linked project outside the window's filter", () => {
    expect(
      windowListProjects(projects, solarOnly, {
        projectId: ProjectId.make("vone"),
        environmentId: EnvironmentId.make("env-b"),
      }),
    ).toEqual([project("env-a", "solar"), project("env-b", "vone")]);
  });

  it("matches a linked project by id alone when the link names no environment", () => {
    expect(
      windowListProjects(projects, solarOnly, {
        projectId: ProjectId.make("quarry"),
        environmentId: undefined,
      }),
    ).toEqual([project("env-a", "solar"), project("env-a", "quarry")]);
  });

  it("keeps the filter as is for no link, a link inside it, or an unknown project", () => {
    for (const projectId of [undefined, "solar", "missing"]) {
      expect(
        windowListProjects(projects, solarOnly, {
          projectId: projectId === undefined ? undefined : ProjectId.make(projectId),
          environmentId: undefined,
        }),
      ).toEqual([project("env-a", "solar")]);
    }
  });
});

describe("windowLandingProjects", () => {
  it("does not reintroduce excluded projects when every project is excluded", () => {
    expect(windowLandingProjects([project("env-a", "solar")], new Set(), null, false)).toEqual([]);
  });

  const projects = [
    project("env-a", "solar"),
    project("env-a", "quarry"),
    project("env-b", "vone"),
  ];

  it.each([
    ["one filtered project", new Set([keyOf("env-a", "quarry")]), [project("env-a", "quarry")]],
    [
      "several filtered projects",
      new Set([keyOf("env-a", "quarry"), keyOf("env-b", "vone")]),
      [project("env-a", "quarry"), project("env-b", "vone")],
    ],
    ["all projects", null, projects],
    ["a filter whose projects are not loaded", new Set([keyOf("env-c", "gone")]), projects],
  ])("%s", (_name, keys, expected) => {
    expect(windowLandingProjects(projects, keys, null)).toEqual(expected);
  });

  it("starts on the seed project before the sidebar applies it", () => {
    expect(
      windowLandingProjects(projects, null, {
        environmentId: EnvironmentId.make("env-b"),
        projectId: ProjectId.make("vone"),
      }),
    ).toEqual([project("env-b", "vone")]);
  });
});
