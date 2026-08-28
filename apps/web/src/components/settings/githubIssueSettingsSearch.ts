import {
  filterAvailableSettingsSearchItems,
  type SettingsSearchAvailability,
  type SettingsSearchItem,
} from "./settingsSearch";

export const GITHUB_ISSUE_HANDOFF_SEARCH_ITEM = {
  id: "github-issue-handoff-prompt",
  title: "GitHub issue handoff prompt",
  to: "/settings/source-control",
} as const satisfies SettingsSearchItem;

export const GITHUB_ISSUE_HANDOFF_SEARCH_ANCHOR = {
  id: GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id,
  title: GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.title,
} as const;

/**
 * Adds the fork-owned issue handoff setting without replacing or reordering
 * upstream's settings catalog. The preferred anchor retains the existing fork
 * order; the section fallback keeps the extension stable on an upstream-only
 * registry during a replay.
 */
export function registerGitHubIssueHandoffSearchItem(
  items: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  if (items.some((item) => item.id === GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id)) return items;

  const preferredAnchorIndex = items.findIndex((item) => item.id === "github-link-destination");
  let insertionIndex = preferredAnchorIndex + 1;

  if (preferredAnchorIndex < 0) {
    insertionIndex = 0;
    for (const [index, item] of items.entries()) {
      if (item.to === GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.to) insertionIndex = index + 1;
    }
  }

  return [
    ...items.slice(0, insertionIndex),
    GITHUB_ISSUE_HANDOFF_SEARCH_ITEM,
    ...items.slice(insertionIndex),
  ];
}

export function filterAvailableGitHubIssueSettingsSearchItems(
  availability: SettingsSearchAvailability,
): ReadonlyArray<SettingsSearchItem> {
  return registerGitHubIssueHandoffSearchItem(filterAvailableSettingsSearchItems(availability));
}
