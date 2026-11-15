// Fork-owned search entry for the worktrunk workspace mode (worktrunk-hooks), spread into
// upstream's `SETTINGS_SEARCH_ITEMS` through one marked hook. The mode is a choice in upstream's
// New threads Workspace row, so the entry points there.
export const worktrunkSearchItemsFork = [
  {
    id: "worktrunk-workspace-mode",
    targetId: "new-threads",
    title: "New worktrunk",
    to: "/settings/threads",
    scope: "project-defaults",
    searchTerms: ["worktrunk wt worktree hooks pre-start pre-remove workspace mode"],
  },
] as const;
