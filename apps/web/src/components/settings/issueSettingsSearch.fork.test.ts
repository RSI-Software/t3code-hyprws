import { describe, expect, it } from "vite-plus/test";

import {
  filterAvailableIssueSettingsSearchItems,
  ISSUE_HANDOFF_SEARCH_ITEM,
  registerIssueHandoffSearchItem,
} from "./issueSettingsSearch";
import {
  filterAvailableSettingsSearchItems,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchAvailability,
  type SettingsSearchItem,
} from "./settingsSearch";

const NOTHING_AVAILABLE: SettingsSearchAvailability = {
  hasCloudPublicConfig: false,
  hasEnvironment: false,
  hasProviderSettingsEnvironment: false,
  canManageLocalBackend: false,
  isWslSettingsRowVisible: false,
  hasThreadAutoSettlement: false,
};

const withoutHandoff: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;

describe("GitHub issue settings search extension", () => {
  it("preserves every registry item and its relative order", () => {
    const extended = registerIssueHandoffSearchItem(withoutHandoff);

    expect(
      extended.filter((item) => item.id !== ISSUE_HANDOFF_SEARCH_ITEM.id).map((item) => item.id),
    ).toEqual(withoutHandoff.map((item) => item.id));
    expect(extended.filter((item) => item.id === ISSUE_HANDOFF_SEARCH_ITEM.id)).toEqual([
      ISSUE_HANDOFF_SEARCH_ITEM,
    ]);
  });

  it("attaches after upstream availability filtering", () => {
    const upstreamAvailable = filterAvailableSettingsSearchItems(NOTHING_AVAILABLE);
    const forkAvailable = filterAvailableIssueSettingsSearchItems(NOTHING_AVAILABLE);

    expect(
      forkAvailable
        .filter((item) => item.id !== ISSUE_HANDOFF_SEARCH_ITEM.id)
        .map((item) => item.id),
    ).toEqual(upstreamAvailable.map((item) => item.id));
    expect(forkAvailable).toContain(ISSUE_HANDOFF_SEARCH_ITEM);
  });

  it("keeps the handoff prompt in source-control order and searchable", () => {
    const extended = registerIssueHandoffSearchItem(withoutHandoff);
    const handoffIndex = extended.findIndex((item) => item.id === ISSUE_HANDOFF_SEARCH_ITEM.id);

    expect(extended[handoffIndex - 1]?.id).toBe("github-link-destination");
    expect(extended[handoffIndex + 1]?.id).toBe("network-access");
    expect(searchSettings("github issue handoff", extended)).toEqual([ISSUE_HANDOFF_SEARCH_ITEM]);
  });

  it("falls back to the end of the upstream source-control section", () => {
    const upstreamOnly: ReadonlyArray<SettingsSearchItem> = [
      { id: "source-control", title: "Source control", to: "/settings/source-control" },
      { id: "git-fetch", title: "Git fetch", to: "/settings/source-control" },
      { id: "network-access", title: "Network access", to: "/settings/connections" },
    ];

    expect(registerIssueHandoffSearchItem(upstreamOnly).map((item) => item.id)).toEqual([
      "source-control",
      "git-fetch",
      ISSUE_HANDOFF_SEARCH_ITEM.id,
      "network-access",
    ]);
  });

  it("does not duplicate a registry that already contains the item", () => {
    const registered = registerIssueHandoffSearchItem(withoutHandoff);

    expect(registerIssueHandoffSearchItem(registered)).toBe(registered);
  });
});
