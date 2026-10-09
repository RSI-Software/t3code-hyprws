import {
  ALL_PROJECTS_FILTER,
  type ProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_PROJECTS_CHOOSER_VALUE,
  projectChooserState,
  projectFilterFromChooser,
  showOnlyProjectFilter,
} from "./projectChooser.fork";

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
const groups = [api, web];

const filterOf = (...selected: Array<typeof api>): ProjectFilter => ({
  entries: selected.map((group) => ({ key: group.projectKey, members: group.memberProjectRefs })),
});
const values = (filter: ProjectFilter) =>
  projectChooserState(filter, groups).value.map((item) => item.value);

describe("project chooser", () => {
  it("exclusion labels the hidden picks rather than presenting one as the shown project", () => {
    const filter: ProjectFilter = { ...filterOf(web), mode: "exclude" };
    const state = projectChooserState(filter, groups);
    expect(state.label).toBe("Projects: All except 1");
    expect(state.titleLabel).toBe("All except web");
    expect(state.single).toBeNull();
    expect(state.value.map((item) => item.value)).toEqual([web.projectKey]);
    expect(projectFilterFromChooser(filter, [web.projectKey, api.projectKey], groups)).toEqual({
      ...filterOf(web, api),
      mode: "exclude",
    });
    expect(projectFilterFromChooser(filter, [], groups)).toEqual({ entries: [], mode: "exclude" });
    expect(
      projectFilterFromChooser(filter, [web.projectKey, ALL_PROJECTS_CHOOSER_VALUE], groups),
    ).toEqual({ entries: [], mode: "exclude" });
    expect(showOnlyProjectFilter(api)).toEqual(filterOf(api));
  });

  it("exclusion can pick its first hidden project from an empty selection", () => {
    const empty: ProjectFilter = { mode: "exclude", entries: [] };
    expect(projectChooserState(empty, groups).label).toBe("Projects: All");
    expect(
      projectFilterFromChooser(empty, [ALL_PROJECTS_CHOOSER_VALUE, web.projectKey], groups),
    ).toEqual({ ...filterOf(web), mode: "exclude" });
  });

  it("Empty: an empty filter selects All projects and reads Projects: All", () => {
    const state = projectChooserState(ALL_PROJECTS_FILTER, groups);
    expect(state.value.map((item) => item.value)).toEqual([ALL_PROJECTS_CHOOSER_VALUE]);
    expect(state.label).toBe("Projects: All");
    expect(state.count).toBe(0);
    expect(state.single).toBeNull();
    expect(state.items.map((item) => item.value)).toEqual([
      ALL_PROJECTS_CHOOSER_VALUE,
      api.projectKey,
      web.projectKey,
    ]);
  });

  it("Label: one entry shows its name, several show a count", () => {
    const one = projectChooserState(filterOf(web), groups);
    expect(one.label).toBe("Projects: web");
    expect(one.single).toBe(web);
    expect(one.value.map((item) => item.value)).toEqual([web.projectKey]);

    const both = projectChooserState(filterOf(api, web), groups);
    expect(both.label).toBe("Projects: 2 selected");
    expect(both.single).toBeNull();
    expect(both.count).toBe(2);
    expect(both.value.map((item) => item.value)).toEqual([api.projectKey, web.projectKey]);
  });

  it("Title: names the selected projects, counting past three; none for all projects", () => {
    expect(projectChooserState(ALL_PROJECTS_FILTER, groups).titleLabel).toBeNull();
    expect(projectChooserState(filterOf(web), groups).titleLabel).toBe("web");
    expect(projectChooserState(filterOf(api, web), groups).titleLabel).toBe("api, web");

    const more = [1, 2, 3, 4].map((index) => ({
      projectKey: `github.com/acme/p${index}`,
      displayName: `p${index}`,
      memberProjectRefs: [ref("local", `p${index}`)],
    }));
    expect(projectChooserState(filterOf(...more), more).titleLabel).toBe("p1, p2, p3 +1");
  });

  it("Toggle: picking a project adds its entry, unpicking removes it", () => {
    const added = projectFilterFromChooser(filterOf(api), [api.projectKey, web.projectKey], groups);
    expect(added).toEqual(filterOf(api, web));

    const removed = projectFilterFromChooser(added, [web.projectKey], groups);
    expect(removed).toEqual(filterOf(web));

    // From All projects, the combobox reports All beside the new pick.
    const fromAll = projectFilterFromChooser(
      ALL_PROJECTS_FILTER,
      [ALL_PROJECTS_CHOOSER_VALUE, api.projectKey],
      groups,
    );
    expect(fromAll).toEqual(filterOf(api));
  });

  it("Toggle: All projects clears the filter, and unpicking the last entry returns to all", () => {
    expect(
      projectFilterFromChooser(
        filterOf(api, web),
        [api.projectKey, web.projectKey, ALL_PROJECTS_CHOOSER_VALUE],
        groups,
      ),
    ).toBe(ALL_PROJECTS_FILTER);
    expect(projectFilterFromChooser(filterOf(api), [], groups)).toBe(ALL_PROJECTS_FILTER);
  });

  it("Offline: an entry no group carries stays selected and is marked unavailable", () => {
    const filter = filterOf(api, web);
    const state = projectChooserState(filter, [api]);
    expect(state.value.map((item) => [item.value, item.unavailable])).toEqual([
      [api.projectKey, false],
      [web.projectKey, true],
    ]);
    expect(state.label).toBe("Projects: 2 selected");

    // Toggling another project keeps the offline entry and its members.
    const next = projectFilterFromChooser(filter, [web.projectKey], [api]);
    expect(next).toEqual(filterOf(web));
    expect(values(next)).toEqual([web.projectKey]);
  });

  it("Show only: the filter becomes that one project, whatever was selected", () => {
    expect(showOnlyProjectFilter(web)).toEqual(filterOf(web));
    expect(values(showOnlyProjectFilter(api))).toEqual([api.projectKey]);
  });
});
