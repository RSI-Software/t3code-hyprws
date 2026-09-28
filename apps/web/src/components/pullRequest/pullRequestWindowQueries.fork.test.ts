import {
  PULL_REQUEST_LIST_PROJECT_LIMIT,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
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

  it("falls back to a readable copy without including hidden projects", () => {
    const listed = [project("solar", "env-1"), project("solar", "env-2")];
    const input = {
      listed,
      held: [...listed, project("hidden", "env-2")],
      environmentIds: envs("env-1", "env-2"),
    };
    expect(pullRequestEnvironmentQueriesFork(input)).toStrictEqual([{ environmentId: "env-1" }]);
    expect(
      pullRequestEnvironmentQueriesFork({
        ...input,
        hostAvailability: new Map([
          [
            "env-1" as EnvironmentId,
            {
              hosts: new Map([["github.com", { configured: false, observedAt: 1 }]]),
              projectHosts: new Map(),
            },
          ],
        ]),
      }),
    ).toStrictEqual([{ environmentId: "env-2", projectIds: ["solar"] }]);
  });

  it("splits a filtered read at the server's project limit", () => {
    const listed = Array.from({ length: PULL_REQUEST_LIST_PROJECT_LIMIT + 1 }, (_, i) =>
      project(`repo-${i}`, "env-1"),
    );
    expect(
      pullRequestEnvironmentQueriesFork({
        listed,
        held: [...listed, project("hidden", "env-1")],
        environmentIds: envs("env-1"),
      }),
    ).toStrictEqual([
      {
        environmentId: "env-1",
        projectIds: listed.slice(0, PULL_REQUEST_LIST_PROJECT_LIMIT).map(({ id }) => id),
      },
      { environmentId: "env-1", projectIds: [listed.at(-1)!.id] },
    ]);
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
