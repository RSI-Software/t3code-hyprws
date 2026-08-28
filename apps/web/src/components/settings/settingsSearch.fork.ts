// Fork seam: the external workspace symlinks search entry, spread into upstream's
// `SETTINGS_SEARCH_ITEMS` through one marked hook. Typed structurally (`as const`)
// rather than via `SettingsSearchItem` so this module stays import-cycle-free when
// `settingsSearch.ts` evaluates first.
export const externalWorkspaceSymlinksSearchItemsFork = [
  {
    id: "external-workspace-symlinks",
    title: "Follow external workspace symlinks",
    to: "/settings/general",
  },
] as const;
