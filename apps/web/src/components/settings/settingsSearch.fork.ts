// Fork-owned seam for the external workspace symlinks search entry
// (RSI-Software/t3code-hyprws#951, reshaping 565594bd75).
//
// Spread into upstream's `SETTINGS_SEARCH_ITEMS` through one marked hook so the
// setting is reachable from the settings search palette. The item is typed
// structurally (`as const`) rather than by importing `SettingsSearchItem`, so
// this module stays import-cycle-free when `settingsSearch.ts` evaluates first.
export const externalWorkspaceSymlinksSearchItemsFork = [
  {
    id: "external-workspace-symlinks",
    title: "Follow external workspace symlinks",
    to: "/settings/general",
  },
] as const;
