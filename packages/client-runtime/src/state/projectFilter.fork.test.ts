import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_PROJECTS_FILTER,
  decodeProjectFilter,
  projectFilterFromKey,
  projectFilterProjectKeys,
  projectFilterScopeKey,
  reconcileProjectFilter,
  type ProjectFilter,
} from "./projectFilter.fork.ts";

const ref = (environmentId: string, projectId: string): ScopedProjectRef => ({
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make(projectId),
});

const api = ref("local", "api");
const webLocal = ref("local", "web");
const webVm = ref("vm", "web");
const docs = ref("local", "docs");

// Repository grouping: one entry per repository, members on every machine.
const byRepository = [
  { key: "github.com/acme/api", members: [api] },
  { key: "github.com/acme/web", members: [webLocal, webVm] },
  { key: "github.com/acme/docs", members: [docs] },
];

const filterOf = (...keys: string[]): ProjectFilter => ({
  entries: keys.map((key) => byRepository.find((group) => group.key === key)!),
});

describe("window project filter model", () => {
  it("Members: entries keep member refs, and the projection is their union", () => {
    const filter = reconcileProjectFilter(
      projectFilterFromKey("github.com/acme/web"),
      byRepository,
      true,
    );
    expect(filter.entries).toEqual([{ key: "github.com/acme/web", members: [webLocal, webVm] }]);

    const both = filterOf("github.com/acme/api", "github.com/acme/web");
    expect(projectFilterProjectKeys(both)).toEqual(new Set(["local:api", "local:web", "vm:web"]));
    // Two entries have no single-select value.
    expect(projectFilterScopeKey(both)).toBeNull();
    expect(projectFilterScopeKey(filter)).toBe("github.com/acme/web");
  });

  it("Grouping: a grouping change re-maps an entry's members", () => {
    const filter = filterOf("github.com/acme/web", "github.com/acme/api");
    // Separate grouping: one entry per physical project.
    const separate = [api, webLocal, webVm, docs].map((member) => ({
      key: `${member.environmentId}:${member.projectId}`,
      members: [member],
    }));

    const regrouped = reconcileProjectFilter(filter, separate, true);
    expect(regrouped.entries.map((entry) => entry.key)).toEqual([
      "local:web",
      "vm:web",
      "local:api",
    ]);
    expect(projectFilterProjectKeys(regrouped)).toEqual(projectFilterProjectKeys(filter));

    // Grouping back merges the split entries into their repository entry again.
    expect(reconcileProjectFilter(regrouped, byRepository, true)).toEqual(filter);
  });

  it("Growth: a project joining a selected group joins the entry", () => {
    const filter = filterOf("github.com/acme/web");
    const webOther = ref("other", "web");
    const grown = byRepository.map((group) =>
      group.key === "github.com/acme/web"
        ? { ...group, members: [...group.members, webOther] }
        : group,
    );

    const reconciled = reconcileProjectFilter(filter, grown, false);
    expect(reconciled.entries[0]!.members).toEqual([webLocal, webVm, webOther]);
    expect(projectFilterProjectKeys(reconciled)?.has("other:web")).toBe(true);
  });

  it("Empty: an empty filter shows all projects and stays empty", () => {
    expect(projectFilterProjectKeys(ALL_PROJECTS_FILTER)).toBeNull();
    expect(projectFilterScopeKey(ALL_PROJECTS_FILTER)).toBeNull();
    expect(projectFilterFromKey(null)).toBe(ALL_PROJECTS_FILTER);
    expect(reconcileProjectFilter(ALL_PROJECTS_FILTER, byRepository, true)).toBe(
      ALL_PROJECTS_FILTER,
    );
  });

  it("Last deleted: deleting the last selected entry returns to all projects", () => {
    const filter = filterOf("github.com/acme/docs", "github.com/acme/api");
    const withoutDocs = byRepository.filter((group) => group.key !== "github.com/acme/docs");
    const afterDocs = reconcileProjectFilter(filter, withoutDocs, true);
    expect(afterDocs).toEqual(filterOf("github.com/acme/api"));

    const withoutApi = withoutDocs.filter((group) => group.key !== "github.com/acme/api");
    const afterApi = reconcileProjectFilter(afterDocs, withoutApi, true);
    expect(afterApi.entries).toEqual([]);
    expect(projectFilterProjectKeys(afterApi)).toBeNull();
  });

  it("an offline entry stays selected, with its members, until projects settle", () => {
    const filter = filterOf("github.com/acme/web", "github.com/acme/api");
    const webOffline = byRepository.filter((group) => group.key !== "github.com/acme/web");

    expect(reconcileProjectFilter(filter, webOffline, false)).toBe(filter);
  });

  it("an unchanged filter is returned as is, so storing it is a no-op", () => {
    const filter = filterOf("github.com/acme/api", "github.com/acme/web");
    expect(reconcileProjectFilter(filter, byRepository, true)).toBe(filter);
  });

  it("decodes a stored filter and drops what it cannot read", () => {
    expect(
      decodeProjectFilter(JSON.parse(JSON.stringify(filterOf("github.com/acme/web")))),
    ).toEqual(filterOf("github.com/acme/web"));
    expect(
      decodeProjectFilter({
        entries: [
          { key: "", members: [] },
          { key: "k", members: [{ environmentId: "e" }, api] },
        ],
      }),
    ).toEqual({ entries: [{ key: "k", members: [api] }] });
    expect(decodeProjectFilter({ scopeKey: "k" })).toBeNull();
    expect(decodeProjectFilter(null)).toBeNull();
  });
});
