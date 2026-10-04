import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browseInputEndPaddingClass,
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";
import {
  buildLinkGitHubIssueActionItemFork,
  refreshNewThreadInViewFork,
  scopePaletteProjectEntriesFork,
  withProjectScopeToggleFork,
} from "./CommandPalette.fork";

describe("browseInputEndPaddingClass", () => {
  it("reserves the widest space for the create action", () => {
    expect(
      browseInputEndPaddingClass({
        willCreateProjectPath: true,
        hasHighlightedBrowseItem: false,
      }),
    ).toContain("pe-38");
  });

  it("reserves space for the wider highlighted-item shortcut", () => {
    expect(
      browseInputEndPaddingClass({
        willCreateProjectPath: false,
        hasHighlightedBrowseItem: true,
      }),
    ).toContain("pe-30");
  });

  it("keeps the compact reserve for the normal add action", () => {
    expect(
      browseInputEndPaddingClass({
        willCreateProjectPath: false,
        hasHighlightedBrowseItem: false,
      }),
    ).toContain("pe-24");
  });
});

describe("palette project scope", () => {
  const ref = (environmentId: string, projectId: string) => ({
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(projectId),
  });
  const entryOf = (name: string) => ({
    name,
    group: { memberProjectRefs: [ref("local", name)] },
  });
  const item = (value: string): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [value],
    title: value,
    icon: null,
    run: async () => {},
  });

  it("Search: the picker shows the filter's projects, or every project when none loaded", () => {
    const entries = [entryOf("api"), entryOf("web")];
    expect(
      scopePaletteProjectEntriesFork(entries, new Set(["local:web"])).map((entry) => entry.name),
    ).toEqual(["web"]);
    expect(scopePaletteProjectEntriesFork(entries, new Set(["local:gone"]))).toBe(entries);
    expect(scopePaletteProjectEntriesFork(entries, null)).toBe(entries);
  });

  it("Search all: the pushed new-thread picker follows the scope, keeping its lead first", () => {
    const pushed = [{ value: "projects", label: "Projects", items: [item("b"), item("a")] }];
    const refreshed = refreshNewThreadInViewFork(pushed, [item("a"), item("b"), item("c")]);
    expect(refreshed[0]!.items.map((entry) => entry.value)).toEqual(["b", "a", "c"]);

    const other = [{ value: "themes", label: "Themes", items: [item("x")] }];
    expect(refreshNewThreadInViewFork(other, [item("a")])).toBe(other);
  });

  it("Search all: the toggle trails the root list and the picker, and nothing else", () => {
    const toggle = item("action:search-all-projects");
    const scope = { projectKeys: new Set(["local:api"]), toggle };
    const results = [{ value: "actions", label: "Actions", items: [item("x")] }];
    expect(withProjectScopeToggleFork(results, scope, null).at(-1)?.items).toEqual([toggle]);
    const picker = {
      addonIcon: null,
      groups: [{ value: "projects", label: "Projects", items: [] }],
    };
    expect(withProjectScopeToggleFork(results, scope, picker).at(-1)?.items).toEqual([toggle]);
    const themes = { addonIcon: null, groups: [{ value: "themes", label: "Themes", items: [] }] };
    expect(withProjectScopeToggleFork(results, scope, themes)).toBe(results);
    expect(withProjectScopeToggleFork(results, { projectKeys: null, toggle: null }, null)).toBe(
      results,
    );
  });
});

describe("link GitHub issue action", () => {
  const linkItem = buildLinkGitHubIssueActionItemFork(
    { environmentId: EnvironmentId.make("local"), id: ThreadId.make("thread-1") },
    { threadIssues: true },
  );
  const search = (query: string) =>
    filterCommandPaletteGroups({
      activeGroups: [{ value: "actions", label: "Actions", items: linkItem ? [linkItem] : [] }],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    }).flatMap((group) => group.items.map((item) => item.value));

  it("matches its own title and its short query", () => {
    expect(search("link github issue to thread")).toEqual(["action:link-github-issue"]);
    expect(search("link github issue")).toEqual(["action:link-github-issue"]);
  });
});
