import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickSharedServerSettings, splitSharedServerPatch } from "./sharedSettings.ts";

// The handoff template is a user preference: a write on one client must fan out
// to every shared-settings target, so the key belongs in
// SHARED_SERVER_SETTING_KEYS (RSI-Software/t3code-hyprws#1048).
describe("github issue handoff prompt template sharing", () => {
  it("routes the handoff prompt template to the shared patch, not the local one", () => {
    const template = "Hand off {{number}}: {{title}} ({{url}})";
    expect(splitSharedServerPatch({ githubIssueHandoffPromptTemplate: template })).toEqual({
      sharedPatch: { githubIssueHandoffPromptTemplate: template },
      localPatch: {},
    });
  });

  it("keeps the handoff prompt template in the shared subset read from an environment", () => {
    const template = "Work on {{number}} — {{title}}";
    expect(
      pickSharedServerSettings({
        ...DEFAULT_SERVER_SETTINGS,
        githubIssueHandoffPromptTemplate: template,
      }),
    ).toMatchObject({ githubIssueHandoffPromptTemplate: template });
  });
});
