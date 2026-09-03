import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildIssuesNavigationCommand, browseInputEndPaddingClass } from "./CommandPalette.logic";

describe("buildIssuesNavigationCommand", () => {
  it("defines the Issues action and preserves project-window scope", () => {
    expect(buildIssuesNavigationCommand(null)).toMatchObject({
      value: "action:issues",
      title: "Go to Issues",
      target: { kind: "hub" },
    });
    expect(
      buildIssuesNavigationCommand({
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
      }),
    ).toMatchObject({
      target: {
        kind: "project",
        projectRef: { environmentId: "environment-1", projectId: "project-1" },
      },
    });
  });
});

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
