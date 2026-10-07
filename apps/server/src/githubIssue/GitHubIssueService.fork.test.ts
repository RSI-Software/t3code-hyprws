// Fork-owned: the light read the linked-issue sync uses (RSI-Software/t3code-hyprws#1451).
// The harness mirrors `GitHubIssueService.test.ts`, which owns the list, detail, and state tests.
import { assert, describe, it, vi } from "@effect/vitest";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
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

function makeService(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  graphql: GitHubApi.GitHubApi["Service"]["graphql"],
) {
  return GitHubIssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubApi.GitHubApi)({ graphql }),
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
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        Effect.succeed(
          JSON.stringify({
            data: {
              repository: {
                issue: { title: "Issue 42", state: "CLOSED", stateReason: "NOT_PLANNED" },
              },
            },
          }),
        ),
      );
      const service = yield* makeService([project("p1")], graphql);

      const summary = yield* service.summary({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 42,
      });

      const call = graphql.mock.calls[0]?.[0];
      assert.strictEqual(call?.host, "github.com");
      assert.include(call?.query ?? "", "title state stateReason");
      assert.deepStrictEqual(call?.variables, { owner: "acme", name: "web", number: 42 });
      assert.deepStrictEqual(summary, {
        title: "Issue 42",
        state: "closed",
        closeReason: "not planned",
      });
    }),
  );
});

// One GraphQL read attaches the children's close reasons the detail read omits, fired only when
// a closed child exists (RSI-Software/t3code-hyprws#1461).
describe("GitHubIssueService detail sub-issue reasons", () => {
  const detailPayload = (children: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({
      data: {
        repository: {
          issue: {
            number: 42,
            title: "Parent",
            url: "https://github.com/acme/web/issues/42",
            author: null,
            assignees: { nodes: [] },
            labels: { nodes: [] },
            issueType: null,
            state: "OPEN",
            stateReason: null,
            createdAt: "2026-08-20T00:00:00Z",
            updatedAt: "2026-08-21T00:00:00Z",
            reactionGroups: null,
            closedAt: null,
            comments: { totalCount: 0, nodes: [] },
            subIssues: { nodes: children },
          },
        },
      },
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

  const makeDetailService = (graphql: GitHubApi.GitHubApi["Service"]["graphql"]) =>
    makeService([project("p1")], graphql).pipe(
      Effect.flatMap((service) =>
        service.detail({ projectId: "p1" as ProjectId, repository: "acme/web", number: 42 }),
      ),
    );

  it.effect("attaches a closed child's reason with exactly one graphql read", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>((call) =>
        call.query.includes("subIssues(first:100)")
          ? Effect.succeed(
              JSON.stringify({
                data: {
                  repository: {
                    issue: { subIssues: { nodes: [{ number: 43, stateReason: "NOT_PLANNED" }] } },
                  },
                },
              }),
            )
          : Effect.succeed(detailPayload([closedChild, openChild])),
      );
      const detail = yield* makeDetailService(graphql);

      assert.strictEqual(graphql.mock.calls.length, 2);
      const reasonsCall = graphql.mock.calls[1]?.[0];
      assert.strictEqual(reasonsCall?.query, SUB_ISSUE_REASONS_QUERY);
      assert.strictEqual(reasonsCall?.host, "github.com");
      assert.deepStrictEqual(reasonsCall?.variables, { owner: "acme", name: "web", number: 42 });
      assert.deepStrictEqual(detail.subIssues, [
        { ...closedChild, state: "closed", closeReason: "not planned" },
        { ...openChild, state: "open", closeReason: null },
      ]);
    }),
  );

  it.effect("skips the graphql read when no sub-issue is closed", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        Effect.succeed(detailPayload([openChild])),
      );
      const detail = yield* makeDetailService(graphql);

      assert.lengthOf(graphql.mock.calls, 1);
      assert.deepStrictEqual(detail.subIssues, [
        { ...openChild, state: "open", closeReason: null },
      ]);
    }),
  );

  it.effect("keeps the detail when the graphql read fails, reason unknown", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>((call) =>
        call.query.includes("subIssues(first:100)")
          ? Effect.fail(
              new GitHubApi.GitHubApiResponseError({
                host: "github.com",
                operation: "subIssueCloseReasons",
                status: 500,
              }),
            )
          : Effect.succeed(detailPayload([closedChild])),
      );
      const detail = yield* makeDetailService(graphql);

      assert.lengthOf(graphql.mock.calls, 2);
      assert.deepStrictEqual(detail.subIssues, [
        { ...closedChild, state: "closed", closeReason: null },
      ]);
    }),
  );
});
