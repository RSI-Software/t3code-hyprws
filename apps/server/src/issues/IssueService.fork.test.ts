// Fork-owned: the light batch read the linked-issue sync uses (RSI-Software/t3code-hyprws#1451).
// The harness mirrors `IssueService.test.ts`, which owns the list, detail, and state tests.
import { assert, describe, it, vi } from "@effect/vitest";
import {
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubIssueGraphQl from "./gitHubIssueGraphQl.fork.ts";
import * as IssueService from "./IssueService.ts";

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
      provider: SourceControlProviderKind.make("github"),
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
  graphql: GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"],
) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitHubIssueGraphQl.GitHubIssueGraphQl)({ graphql }),
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

describe("IssueService summaries", () => {
  it.effect("reads a repository's issues in aliased batches and leaves out missing ones", () =>
    Effect.gen(function* () {
      const child = {
        number: 60,
        title: "Child",
        url: "https://github.com/acme/web/issues/60",
        state: "CLOSED",
        stateReason: "COMPLETED",
      };
      const graphql = vi.fn<GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"]>((call) =>
        Effect.succeed(
          JSON.stringify({
            data: {
              repository: Object.fromEntries(
                [...call.query.matchAll(/i(\d+):issue/gu)].map(([, number]) => [
                  `i${number}`,
                  // #2 is a pull request or gone: GitHub answers that alias null.
                  number === "2"
                    ? null
                    : {
                        title: `Issue ${number}`,
                        state: "CLOSED",
                        stateReason: "NOT_PLANNED",
                        parent: null,
                        subIssues: { nodes: number === "1" ? [child] : [] },
                        labels: { nodes: number === "1" ? [{ name: "bug", color: "d73a4a" }] : [] },
                        issueType: number === "1" ? { name: "Task", color: "YELLOW" } : null,
                      },
                ]),
              ),
            },
          }),
        ),
      );
      const service = yield* makeService([project("p1")], graphql);
      const numbers = Array.from(
        { length: IssueService.ISSUE_SUMMARIES_PER_REQUEST + 1 },
        (_, index) => index + 1,
      );

      const summaries = yield* service.summaries({
        host: "github.com",
        repository: "acme/web",
        numbers,
      });

      assert.lengthOf(graphql.mock.calls, 2);
      const call = graphql.mock.calls[0]?.[0];
      assert.strictEqual(call?.host, "github.com");
      assert.strictEqual(call?.partialNotFound, true);
      assert.deepStrictEqual(call?.variables, { owner: "acme", name: "web" });
      assert.strictEqual(summaries.size, numbers.length - 1);
      assert.isFalse(summaries.has(2));
      // A bare issue's summary leaves out the empty keys, so its snapshot keeps its shape.
      assert.deepStrictEqual(summaries.get(51), {
        title: "Issue 51",
        state: "closed",
        closeReason: "not planned",
      });
      assert.deepInclude(summaries.get(1), {
        subIssues: [
          { number: 60, title: "Child", url: child.url, state: "closed", closeReason: "completed" },
        ],
        labels: [{ name: "bug", color: "d73a4a" }],
        issueType: { name: "Task", color: "YELLOW" },
      });
    }),
  );
});

describe("IssueService isPullRequest", () => {
  it.effect("is true only for a confirmed pull request, false when GitHub cannot answer", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"]>((call) =>
        call.variables?.["number"] === 3
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: "ghe.acme.test",
                operation: "isPullRequest",
                status: 502,
              }),
            )
          : Effect.succeed(
              JSON.stringify({
                data: {
                  repository: {
                    issueOrPullRequest: {
                      __typename: call.variables?.["number"] === 1 ? "PullRequest" : "Issue",
                    },
                  },
                },
              }),
            ),
      );
      const service = yield* makeService([], graphql);
      const kinds = yield* Effect.forEach([1, 2, 3], (number) =>
        service.isPullRequest({ host: "ghe.acme.test", repository: "acme/web", number }),
      );

      assert.deepStrictEqual(kinds, [true, false, false]);
      assert.strictEqual(graphql.mock.calls[0]?.[0].host, "ghe.acme.test");
      assert.deepStrictEqual(graphql.mock.calls[0]?.[0].variables, {
        owner: "acme",
        name: "web",
        number: 1,
      });
    }),
  );
});

describe("IssueService reference", () => {
  it.effect("maps each state, answers null for a missing reference, and fails on outages", () =>
    Effect.gen(function* () {
      const nodes: Record<number, unknown> = {
        1: { __typename: "PullRequest", state: "MERGED", isDraft: false },
        2: { __typename: "PullRequest", state: "OPEN", isDraft: true },
        3: { __typename: "Issue", state: "CLOSED", stateReason: "NOT_PLANNED" },
        4: { __typename: "Issue", state: "CLOSED", stateReason: "COMPLETED" },
        5: null,
      };
      const graphql = vi.fn<GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"]>((call) => {
        const number = call.variables?.["number"] as number;
        const context = { host: call.host, operation: call.operation };
        if (number === 6)
          return Effect.fail(new GitHubRequestPolicy.GitHubApiNotFoundError(context));
        if (number === 7) {
          return Effect.fail(
            new GitHubRequestPolicy.GitHubApiResponseError({ ...context, status: 502 }),
          );
        }
        const node = nodes[number];
        return Effect.succeed(
          JSON.stringify({
            data: {
              repository: {
                owner: { avatarUrl: "https://avatars.test/acme" },
                issueOrPullRequest: node && {
                  ...node,
                  title: `Ref ${number}`,
                  url: `https://github.com/acme/web/issues/${number}`,
                  updatedAt: "2026-11-01T00:00:00Z",
                  author: { login: "octo", avatarUrl: null },
                },
              },
            },
          }),
        );
      });
      const service = yield* makeService([], graphql);
      const read = (number: number) =>
        service.reference({ host: "github.com", repository: "acme/web", number });

      const states = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (number) =>
        read(number).pipe(Effect.map((summary) => summary?.state ?? null)),
      );
      assert.deepStrictEqual(states, ["merged", "draft", "not-planned", "closed", null, null]);
      const first = yield* read(1);
      assert.strictEqual(first?.kind, "pull-request");
      assert.strictEqual(first?.ownerAvatarUrl, "https://avatars.test/acme");
      assert.deepStrictEqual(first?.author, { login: "octo", avatarUrl: null });
      const outage = yield* Effect.flip(read(7));
      assert.deepInclude(outage, { _tag: "GitHubIssueOperationError", operation: "reference" });
    }),
  );
});

describe("IssueService detail hierarchy", () => {
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

  const openChild = {
    number: 44,
    title: "Render the list",
    url: "https://github.com/acme/web/issues/44",
    state: "OPEN",
  };

  const makeDetailService = (
    graphql: GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"],
  ) =>
    makeService([project("p1")], graphql).pipe(
      Effect.flatMap((service) =>
        service.detail({ projectId: "p1" as ProjectId, repository: "acme/web", number: 42 }),
      ),
    );

  it.effect("selects and decodes the parent without an extra read", () =>
    Effect.gen(function* () {
      const payload = JSON.parse(detailPayload([]));
      payload.data.repository.issue.parent = { ...openChild, title: "Parent tracker" };
      const graphql = vi.fn<GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"]>(() =>
        Effect.succeed(JSON.stringify(payload)),
      );
      const detail = yield* makeDetailService(graphql);
      assert.include(
        graphql.mock.calls[0]?.[0].query ?? "",
        "parent { number title url state stateReason }",
      );
      assert.deepStrictEqual(detail.parent, {
        ...openChild,
        title: "Parent tracker",
        state: "open",
        closeReason: null,
      });
      assert.lengthOf(graphql.mock.calls, 1);
    }),
  );

  it.effect("uses advanced search for issue types and preserves an older ranked issue", () =>
    Effect.gen(function* () {
      const row = JSON.parse(detailPayload([])).data.repository.issue;
      const graphql = vi.fn<GitHubIssueGraphQl.GitHubIssueGraphQl["Service"]["graphql"]>(() =>
        Effect.succeed(
          JSON.stringify({
            data: {
              search: {
                nodes: Array.from({ length: 51 }, (_, index) => ({
                  ...row,
                  number: index + 1,
                  title: `Issue ${index + 1}`,
                  updatedAt: index === 50 ? "2025-01-01T00:00:00Z" : row.updatedAt,
                  comments: { totalCount: index === 50 ? 100 : 0 },
                })).toSorted((left, right) => right.comments.totalCount - left.comments.totalCount),
              },
            },
          }),
        ),
      );
      const service = yield* makeService([project("p1")], graphql);
      const list = yield* service.list({
        state: "open",
        listViewFork: {
          filters: [{ field: "type", operator: "is", values: ["Bug"] }],
          order: { sort: "comments", direction: "desc" },
        },
      });
      assert.strictEqual(graphql.mock.calls[0]?.[0].variables?.type, "ISSUE_ADVANCED");
      assert.strictEqual(
        graphql.mock.calls[0]?.[0].variables?.query,
        'repo:acme/web is:issue state:open type:"Bug" sort:comments-desc',
      );
      assert.strictEqual(list.entries[0]?.number, 51);
      assert.lengthOf(list.entries, 50);
    }),
  );
});
