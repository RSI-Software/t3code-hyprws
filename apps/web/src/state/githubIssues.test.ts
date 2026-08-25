import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { allEnvironmentShellsBootstrappedAtom, environmentShellBootstrappedAtom } from "./shell";
import { githubIssueShellBootstrappedAtom } from "./githubIssues";

describe("githubIssueShellBootstrappedAtom", () => {
  it("uses the all-environment atom instead of subscribing to a sentinel environment", () => {
    expect(githubIssueShellBootstrappedAtom(null)).toBe(allEnvironmentShellsBootstrappedAtom);
  });

  it("uses only the selected environment atom when one is named", () => {
    const environmentId = EnvironmentId.make("environment-1");
    expect(githubIssueShellBootstrappedAtom(environmentId)).toBe(
      environmentShellBootstrappedAtom(environmentId),
    );
  });
});
