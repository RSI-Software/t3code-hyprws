import { describe, expect, it } from "vite-plus/test";

import {
  filterAvailableGitHubIssueSettingsSearchItems,
  GITHUB_ISSUE_HANDOFF_SEARCH_ITEM,
  registerGitHubIssueHandoffSearchItem,
} from "./githubIssueSettingsSearch";
import {
  filterAvailableSettingsSearchItems,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchAvailability,
  type SettingsSearchItem,
} from "./settingsSearch";

const NOTHING_AVAILABLE: SettingsSearchAvailability = {
  hasCloudPublicConfig: false,
  hasPrimaryEnvironment: false,
  hasProviderSettingsEnvironment: false,
  canManageLocalBackend: false,
  isWslSettingsRowVisible: false,
  hasThreadAutoSettlement: false,
};

const withoutHandoff: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;

describe("GitHub issue settings search extension", () => {
  it("preserves every registry item and its relative order", () => {
    const extended = registerGitHubIssueHandoffSearchItem(withoutHandoff);

    expect(
      extended
        .filter((item) => item.id !== GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id)
        .map((item) => item.id),
    ).toEqual(withoutHandoff.map((item) => item.id));
    expect(extended.filter((item) => item.id === GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id)).toEqual([
      GITHUB_ISSUE_HANDOFF_SEARCH_ITEM,
    ]);
  });

  it("attaches after upstream availability filtering", () => {
    const upstreamAvailable = filterAvailableSettingsSearchItems(NOTHING_AVAILABLE);
    const forkAvailable = filterAvailableGitHubIssueSettingsSearchItems(NOTHING_AVAILABLE);

    expect(
      forkAvailable
        .filter((item) => item.id !== GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id)
        .map((item) => item.id),
    ).toEqual(upstreamAvailable.map((item) => item.id));
    expect(forkAvailable).toContain(GITHUB_ISSUE_HANDOFF_SEARCH_ITEM);
  });

  it("keeps the handoff prompt in source-control order and searchable", () => {
    const extended = registerGitHubIssueHandoffSearchItem(withoutHandoff);
    const handoffIndex = extended.findIndex(
      (item) => item.id === GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id,
    );

    expect(extended[handoffIndex - 1]?.id).toBe("github-link-destination");
    expect(extended[handoffIndex + 1]?.id).toBe("network-access");
    expect(searchSettings("github issue handoff", extended)).toEqual([
      GITHUB_ISSUE_HANDOFF_SEARCH_ITEM,
    ]);
  });

  it("falls back to the end of the upstream source-control section", () => {
    const upstreamOnly: ReadonlyArray<SettingsSearchItem> = [
      { id: "source-control", title: "Source control", to: "/settings/source-control" },
      { id: "git-fetch", title: "Git fetch", to: "/settings/source-control" },
      { id: "network-access", title: "Network access", to: "/settings/connections" },
    ];

    expect(registerGitHubIssueHandoffSearchItem(upstreamOnly).map((item) => item.id)).toEqual([
      "source-control",
      "git-fetch",
      GITHUB_ISSUE_HANDOFF_SEARCH_ITEM.id,
      "network-access",
    ]);
  });

  it("does not duplicate a registry that already contains the item", () => {
    const registered = registerGitHubIssueHandoffSearchItem(withoutHandoff);

    expect(registerGitHubIssueHandoffSearchItem(registered)).toBe(registered);
  });
});
