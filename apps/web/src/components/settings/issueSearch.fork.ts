// Fork-owned search entries for the issue rows in Settings → Source control (github-issues),
// spread into upstream's `SETTINGS_SEARCH_ITEMS` through one marked hook. Typed structurally
// (`as const`) so this module stays import-cycle-free when `settingsSearch.ts` evaluates first.
export const issueSearchItemsFork = [
  {
    id: "github-issue-handoff-prompt",
    title: "GitHub issue handoff prompt",
    to: "/settings/source-control",
  },
  {
    id: "linear-api-key",
    title: "Linear API key",
    to: "/settings/source-control",
    searchTerms: ["linear issues token personal api key secret credential"],
  },
] as const;
