import {
  ALL_PROJECTS_FILTER,
  type ProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addProjectFilterEntry,
  chatNewMatchesCurrentProject,
  outsideFilterProjectGroup,
  resolveFilteredNewThread,
  scopeToProjectKeys,
} from "./projectFilterScope.fork";

const ref = (environmentId: string, projectId: string): ScopedProjectRef => ({
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make(projectId),
});

const api = {
  projectKey: "github.com/acme/api",
  displayName: "api",
  memberProjectRefs: [ref("local", "api")],
};
const web = {
  projectKey: "github.com/acme/web",
  displayName: "web",
  memberProjectRefs: [ref("local", "web"), ref("vm", "web")],
};
const docs = {
  projectKey: "github.com/acme/docs",
  displayName: "docs",
  memberProjectRefs: [ref("local", "docs")],
};
const groups = [api, web, docs];

const filterOf = (...selected: Array<typeof api>): ProjectFilter => ({
  entries: selected.map((group) => ({ key: group.projectKey, members: group.memberProjectRefs })),
});

describe("outside thread", () => {
  it("adding an excluded open thread's project removes its exclusion", () => {
    const filter: ProjectFilter = { ...filterOf(api, web), mode: "exclude" };
    expect(outsideFilterProjectGroup(filter, groups, ref("vm", "web"))).toBe(web);
    expect(outsideFilterProjectGroup(filter, groups, ref("local", "docs"))).toBeNull();
    const added = addProjectFilterEntry(filter, web);
    expect(added).toEqual({ ...filterOf(api), mode: "exclude" });
    expect(outsideFilterProjectGroup(added, groups, ref("vm", "web"))).toBeNull();
    expect(addProjectFilterEntry(added, docs)).toBe(added);
  });

  it("Outside: a thread outside the filter names the group to add", () => {
    expect(outsideFilterProjectGroup(filterOf(api), groups, ref("vm", "web"))).toBe(web);
  });

  it("Outside: nothing to add under all projects, inside the filter, or for an unknown project", () => {
    expect(outsideFilterProjectGroup(ALL_PROJECTS_FILTER, groups, ref("local", "web"))).toBeNull();
    expect(outsideFilterProjectGroup(filterOf(web), groups, ref("vm", "web"))).toBeNull();
    expect(outsideFilterProjectGroup(filterOf(api), groups, ref("local", "gone"))).toBeNull();
  });

  it("Add project: adds its entry beside the others, once", () => {
    const added = addProjectFilterEntry(filterOf(api), web);
    expect(added).toEqual(filterOf(api, web));
    expect(outsideFilterProjectGroup(added, groups, ref("vm", "web"))).toBeNull();
    expect(addProjectFilterEntry(added, web)).toBe(added);
  });
});

describe("new thread under the filter", () => {
  it("exclusion opens the scoped picker rather than creating in the hidden project", () => {
    const filter: ProjectFilter = { ...filterOf(api), mode: "exclude" };
    expect(resolveFilteredNewThread({ filter, contextProjectRef: null, direct: false })).toEqual({
      kind: "choose",
    });
    expect(
      resolveFilteredNewThread({ filter, contextProjectRef: ref("local", "api"), direct: true }),
    ).toEqual({ kind: "project", projectRef: ref("local", "api") });
  });

  it("New thread: all projects keeps upstream's resolution", () => {
    for (const direct of [false, true]) {
      expect(
        resolveFilteredNewThread({
          filter: ALL_PROJECTS_FILTER,
          contextProjectRef: ref("local", "api"),
          direct,
        }),
      ).toEqual({ kind: "default" });
    }
  });

  it("New thread: one project uses it, preferring the viewed member", () => {
    expect(
      resolveFilteredNewThread({ filter: filterOf(web), contextProjectRef: null, direct: false }),
    ).toEqual({ kind: "project", projectRef: ref("local", "web") });
    expect(
      resolveFilteredNewThread({
        filter: filterOf(web),
        contextProjectRef: ref("vm", "web"),
        direct: false,
      }),
    ).toEqual({ kind: "project", projectRef: ref("vm", "web") });
    // A viewed thread outside the one project does not pull the new thread out.
    expect(
      resolveFilteredNewThread({
        filter: filterOf(web),
        contextProjectRef: ref("local", "api"),
        direct: false,
      }),
    ).toEqual({ kind: "project", projectRef: ref("local", "web") });
  });

  it("New thread: several projects ask, never picking a member silently", () => {
    const filter = filterOf(api, web);
    expect(resolveFilteredNewThread({ filter, contextProjectRef: null, direct: false })).toEqual({
      kind: "choose",
    });
    expect(
      resolveFilteredNewThread({ filter, contextProjectRef: ref("local", "api"), direct: false }),
    ).toEqual({ kind: "choose" });
    // "Current project" with nothing viewed still asks.
    expect(resolveFilteredNewThread({ filter, contextProjectRef: null, direct: true })).toEqual({
      kind: "choose",
    });
  });

  it("New thread: current project names the viewed project explicitly", () => {
    expect(
      resolveFilteredNewThread({
        filter: filterOf(api, web),
        contextProjectRef: ref("local", "docs"),
        direct: true,
      }),
    ).toEqual({ kind: "project", projectRef: ref("local", "docs") });
  });

  it("New thread: a one-entry filter whose projects have not loaded keeps upstream's resolution", () => {
    const unloaded: ProjectFilter = { entries: [{ key: "github.com/acme/gone", members: [] }] };
    expect(
      resolveFilteredNewThread({ filter: unloaded, contextProjectRef: null, direct: false }),
    ).toEqual({ kind: "default" });
  });
});

describe("new thread shortcut hint", () => {
  const viewing = (projectRef: ScopedProjectRef) => ({
    activeDraftThread: null,
    activeThread: projectRef,
    defaultProjectRef: null,
  });

  it("New thread: the hint shows where the shortcut lands on the current project", () => {
    expect(chatNewMatchesCurrentProject(ALL_PROJECTS_FILTER, viewing(ref("local", "docs")))).toBe(
      true,
    );
    expect(chatNewMatchesCurrentProject(filterOf(web), viewing(ref("vm", "web")))).toBe(true);
  });

  it("New thread: the hint hides where the shortcut opens the picker or lands elsewhere", () => {
    expect(chatNewMatchesCurrentProject(filterOf(api, web), viewing(ref("local", "api")))).toBe(
      false,
    );
    expect(chatNewMatchesCurrentProject(filterOf(api), viewing(ref("local", "web")))).toBe(false);
  });
});

describe("scoped lists", () => {
  const threads = [
    { id: "a", key: "local:api" },
    { id: "w", key: "vm:web" },
    { id: "d", key: "local:docs" },
  ];

  it("Search: a scope keeps only its projects' items", () => {
    expect(
      scopeToProjectKeys(threads, new Set(["local:api", "vm:web"]), (thread) => [thread.key]).map(
        (thread) => thread.id,
      ),
    ).toEqual(["a", "w"]);
  });

  it("Search all: no scope reaches every project", () => {
    expect(scopeToProjectKeys(threads, null, (thread) => [thread.key])).toBe(threads);
  });
});
