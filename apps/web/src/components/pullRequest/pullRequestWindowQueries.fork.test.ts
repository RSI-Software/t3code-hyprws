import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestEnvironmentQueriesFork } from "./pullRequestWindowQueries.fork";

const project = (id: string, environmentId: string) => ({
  id: id as ProjectId,
  environmentId: environmentId as EnvironmentId,
  repositoryIdentity: { canonicalKey: `github.com/acme/${id}` },
});

const envs = (...ids: ReadonlyArray<string>) => ids as ReadonlyArray<EnvironmentId>;

describe("pull request reads for a window's filter", () => {
  const held = [project("solar", "env-1"), project("quarry", "env-1"), project("vone", "env-2")];

  it("asks only for the filtered projects, counting what each server holds", () => {
    expect(
      pullRequestEnvironmentQueriesFork({
        listed: [project("solar", "env-1")],
        held,
        environmentIds: envs("env-1", "env-2"),
      }),
    ).toStrictEqual([{ environmentId: "env-1", projectIds: ["solar"] }]);
  });

  it("drops the project filter for a server listing everything it holds", () => {
    expect(
      pullRequestEnvironmentQueriesFork({
        listed: held,
        held,
        environmentIds: envs("env-1", "env-2"),
      }),
    ).toStrictEqual([{ environmentId: "env-1" }, { environmentId: "env-2" }]);
  });
});
