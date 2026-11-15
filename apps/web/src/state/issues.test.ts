import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { environmentShellBootstrappedAtom } from "./windowProjectBootstrap.fork";
import { issueShellBootstrappedAtom } from "./issues";

describe("issueShellBootstrappedAtom", () => {
  it("uses the all-environment atom instead of subscribing to a sentinel environment", () => {
    expect(issueShellBootstrappedAtom(null)).toBe(allEnvironmentShellsBootstrappedAtom);
  });

  it("uses only the selected environment atom when one is named", () => {
    const environmentId = EnvironmentId.make("environment-1");
    expect(issueShellBootstrappedAtom(environmentId)).toBe(
      environmentShellBootstrappedAtom(environmentId),
    );
  });
});
