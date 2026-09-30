// Fork-owned: the light read the linked-issue sync uses (RSI-Software/t3code-hyprws#1451).
// The harness mirrors `GitHubIssueService.test.ts`, which owns the list, detail, and state tests.
import { assert, describe, it, vi } from "@effect/vitest";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueService from "./GitHubIssueService.ts";

function project(id: string): OrchestrationProjectShell {
  return {
    id: id as ProjectId,
    title: id,
    workspaceRoot: "/web",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/web.git",
      },
      provider: "github",
      displayName: "acme/web",
      owner: "acme",
      name: "web",
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
  };
}

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeService(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  execute: GitHubCli.GitHubCli["Service"]["execute"],
) {
  return GitHubIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubCli.GitHubCli)({ execute }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(projects),
          getShell: (projectId) =>
            Effect.succeed(
              Option.fromNullishOr(projects.find((project) => project.id === projectId)),
            ),
        }),
        // Every fixture project carries its identity, so none is resolved on demand.
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
      ),
    ),
  );
}

describe("GitHubIssueService summary", () => {
  it.effect("reads only the title and state a linked-issue sync stores", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output(JSON.stringify({ title: "Issue 42", state: "OPEN" }))),
      );
      const service = yield* makeService([project("p1")], execute);

      const summary = yield* service.summary({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 42,
      });

      assert.deepStrictEqual(execute.mock.calls[0]?.[0].args, [
        "issue",
        "view",
        "42",
        "--repo",
        "github.com/acme/web",
        "--json",
        "title,state",
      ]);
      assert.deepStrictEqual(summary, { title: "Issue 42", state: "open" });
    }),
  );
});
