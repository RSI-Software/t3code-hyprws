import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildIssuesNavigationCommand } from "./CommandPalette.logic";

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
