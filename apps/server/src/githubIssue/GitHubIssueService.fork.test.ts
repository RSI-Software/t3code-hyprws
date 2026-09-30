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
import { SUB_ISSUE_REASONS_QUERY } from "./subIssueCloseReasons.fork.ts";

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
  it.effect("reads only the fields a linked-issue sync stores", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(
          output(
            JSON.stringify({ title: "Issue 42", state: "CLOSED", stateReason: "NOT_PLANNED" }),
          ),
        ),
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
        "title,state,stateReason",
      ]);
      assert.deepStrictEqual(summary, {
        title: "Issue 42",
        state: "closed",
        closeReason: "not planned",
      });
    }),
  );
});

// One GraphQL read attaches the children's close reasons `gh` omits, fired only when a closed
// child exists (RSI-Software/t3code-hyprws#1461).
describe("GitHubIssueService detail sub-issue reasons", () => {
  const detailPayload = (children: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({
      number: 42,
      title: "Parent",
      url: "https://github.com/acme/web/issues/42",
      author: null,
      assignees: [],
      labels: [],
      state: "OPEN",
      createdAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-08-21T00:00:00Z",
      closedAt: null,
      subIssues: { nodes: children },
    });

  const closedChild = {
    number: 43,
    title: "Drop the list",
    url: "https://github.com/acme/web/issues/43",
    state: "CLOSED",
  };
  const openChild = {
    number: 44,
    title: "Render the list",
    url: "https://github.com/acme/web/issues/44",
    state: "OPEN",
  };

  const makeDetailService = (execute: GitHubCli.GitHubCli["Service"]["execute"]) =>
    makeService([project("p1")], execute).pipe(
      Effect.flatMap((service) =>
        service.detail({ projectId: "p1" as ProjectId, repository: "acme/web", number: 42 }),
      ),
    );

  it.effect("attaches a closed child's reason with exactly one graphql read", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
        input.args[0] === "issue"
          ? Effect.succeed(output(detailPayload([closedChild, openChild])))
          : Effect.succeed(
              output(
                JSON.stringify({
                  data: {
                    repository: {
                      issue: { subIssues: { nodes: [{ number: 43, stateReason: "NOT_PLANNED" }] } },
                    },
                  },
                }),
              ),
            ),
      );
      const detail = yield* makeDetailService(execute);

      assert.deepStrictEqual(execute.mock.calls[1]?.[0].args, [
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "-f",
        `query=${SUB_ISSUE_REASONS_QUERY}`,
        "-f",
        "owner=acme",
        "-f",
        "name=web",
        "-F",
        "number=42",
      ]);
      assert.deepStrictEqual(detail.subIssues, [
        { ...closedChild, state: "closed", closeReason: "not planned" },
        { ...openChild, state: "open", closeReason: null },
      ]);
    }),
  );

  it.effect("skips the graphql read when no sub-issue is closed", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output(detailPayload([openChild]))),
      );
      const detail = yield* makeDetailService(execute);

      assert.lengthOf(execute.mock.calls, 1);
      assert.deepStrictEqual(detail.subIssues, [
        { ...openChild, state: "open", closeReason: null },
      ]);
    }),
  );

  it.effect("keeps the detail when the graphql read fails, reason unknown", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
        input.args[0] === "issue"
          ? Effect.succeed(output(detailPayload([closedChild])))
          : Effect.fail(
              new GitHubCli.GitHubCliCommandError({ command: "gh", cwd: "/web", cause: "boom" }),
            ),
      );
      const detail = yield* makeDetailService(execute);

      assert.lengthOf(execute.mock.calls, 2);
      assert.deepStrictEqual(detail.subIssues, [
        { ...closedChild, state: "closed", closeReason: null },
      ]);
    }),
  );
});
