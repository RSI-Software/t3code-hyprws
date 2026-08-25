import { expect, it } from "vite-plus/test";

import { splitSharedServerPatch } from "./sharedSettings.ts";

it("shares the GitHub issue handoff template instead of storing it locally", () => {
  const template = "Hand off {{number}}: {{title}} ({{url}})";
  expect(splitSharedServerPatch({ githubIssueHandoffPromptTemplate: template })).toEqual({
    sharedPatch: { githubIssueHandoffPromptTemplate: template },
    localPatch: {},
  });
});
