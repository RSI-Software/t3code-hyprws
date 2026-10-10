import { assert, describe, it, vi } from "@effect/vitest";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubIssueService from "./GitHubIssueService.ts";

function project(input: {
  id: string;
  title: string;
  workspaceRoot: string;
  repository?: string;
  provider?: string;
  host?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? "github.com";
  const repository = input.repository ?? "acme/web";
  const [owner = "acme", name = "web"] = repository.split("/");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: {
      canonicalKey: `${host}/${repository}`,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${host}/${repository}.git`,
      },
      provider: input.provider ?? "github",
      displayName: repository,
      owner,
      name,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:00Z",
  };
}

/** One issue row exactly as the GraphQL selection answers it. */
function issueRow(number: number, updatedAt = "2026-08-21T00:00:00Z") {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    author: { login: "octocat", name: null },
    assignees: { nodes: [] },
    labels: { nodes: [] },
    issueType: null,
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt,
    reactionGroups: null,
    comments: { totalCount: 0 },
  };
}

function commentNode(index: number) {
  return {
    id: `comment-${index}`,
    author: null,
    body: `Comment ${index}`,
    createdAt: `2026-08-21T01:${String(index % 60).padStart(2, "0")}:00Z`,
    updatedAt: `2026-08-21T02:${String(index % 60).padStart(2, "0")}:00Z`,
    url: `https://github.com/acme/web/issues/42#issuecomment-${index}`,
  };
}

const searchAnswer = (rows: ReadonlyArray<unknown>) =>
  Effect.succeed(JSON.stringify({ data: { search: { nodes: rows } } }));

const issueAnswer = (row: unknown) =>
  Effect.succeed(JSON.stringify({ data: { repository: { issue: row } } }));

const issueIdAnswer = (id: string) =>
  Effect.succeed(JSON.stringify({ data: { repository: { issue: { id } } } }));

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

describe("GitHubIssueService", () => {
  it.effect("composes the search qualifiers while discovering only GitHub projects", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        searchAnswer([issueRow(2), issueRow(1)]),
      );
      const service = yield* makeService(
        [
          project({ id: "p1", title: "web", workspaceRoot: "/web" }),
          project({
            id: "p2",
            title: "gitlab",
            workspaceRoot: "/other",
            repository: "acme/other",
            provider: "gitlab",
          }),
        ],
        graphql,
      );

      yield* service.list({ state: "open", query: "websocket", limit: 1 });

      assert.strictEqual(graphql.mock.calls.length, 1);
      const call = graphql.mock.calls[0]?.[0];
      assert.strictEqual(call?.host, "github.com");
      assert.strictEqual(
        call?.variables?.query,
        "repo:acme/web is:issue state:open websocket sort:updated-desc",
      );
      // The +1 that detects truncation rides the same page.
      assert.strictEqual(call?.variables?.first, 2);
    }),
  );

  it.effect("sends sort:updated-desc when no user query is present", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() => searchAnswer([]));
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      yield* service.list({ state: "all" });
      assert.strictEqual(
        graphql.mock.calls[0]?.[0].variables?.query,
        "repo:acme/web is:issue sort:updated-desc",
      );
    }),
  );

  it.effect("routes Enterprise repositories to their host", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() => searchAnswer([]));
      const service = yield* makeService(
        [
          project({
            id: "p1",
            title: "internal",
            workspaceRoot: "/internal",
            repository: "acme/internal",
            host: "ghe.acme.dev",
          }),
        ],
        graphql,
      );
      yield* service.list({ state: "open" });
      const call = graphql.mock.calls[0]?.[0];
      assert.strictEqual(call?.host, "ghe.acme.dev");
      assert.strictEqual(
        call?.variables?.query,
        "repo:acme/internal is:issue state:open sort:updated-desc",
      );
    }),
  );

  it.effect("applies project filtering before repository de-duplication", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        searchAnswer([issueRow(7)]),
      );
      const service = yield* makeService(
        [
          project({ id: "p1", title: "first", workspaceRoot: "/first" }),
          project({ id: "p2", title: "selected", workspaceRoot: "/selected" }),
        ],
        graphql,
      );
      const result = yield* service.list({ state: "open", projectId: "p2" as ProjectId });
      assert.strictEqual(graphql.mock.calls.length, 1);
      assert.strictEqual(result.entries[0]?.projectId, "p2");
    }),
  );

  it.effect("sorts mixed timezone offsets by instant and limits globally", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>((call) =>
        Effect.succeed(
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  String(call.variables?.query).includes("acme/api")
                    ? issueRow(2, "2026-08-21T02:00:00Z")
                    : issueRow(1, "2026-08-21T03:30:00+02:00"),
                ],
              },
            },
          }),
        ),
      );
      const service = yield* makeService(
        [
          project({ id: "p1", title: "web", workspaceRoot: "/web" }),
          project({ id: "p2", title: "api", workspaceRoot: "/api", repository: "acme/api" }),
        ],
        graphql,
      );
      const result = yield* service.list({ state: "all", limit: 1 });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.number),
        [2],
      );
      assert.strictEqual(result.truncated, true);
    }),
  );

  it.effect("marks a per-repository overflow as truncated", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        searchAnswer([issueRow(3), issueRow(2), issueRow(1)]),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const result = yield* service.list({ state: "open", limit: 2 });
      assert.strictEqual(result.entries.length, 2);
      assert.strictEqual(result.truncated, true);
    }),
  );

  it.effect("carries each row's true comment count from the search answer", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        searchAnswer([issueRow(5), { ...issueRow(6), comments: { totalCount: 12 } }]),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const result = yield* service.list({ state: "open" });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.commentCount),
        [0, 12],
      );
    }),
  );

  it.effect("keeps healthy rows when one host is unauthenticated", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>((call) =>
        call.host === "ghe.acme.dev"
          ? Effect.fail(
              new GitHubApi.GitHubApiAuthenticationError({
                host: call.host,
                operation: "listIssues",
              }),
            )
          : searchAnswer([issueRow(7)]),
      );
      const service = yield* makeService(
        [
          project({ id: "p1", title: "web", workspaceRoot: "/web" }),
          project({
            id: "p2",
            title: "internal",
            workspaceRoot: "/enterprise",
            repository: "acme/internal",
            host: "ghe.acme.dev",
          }),
        ],
        graphql,
      );
      const result = yield* service.list({ state: "open" });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.number),
        [7],
      );
      assert.strictEqual(result.errors.length, 1);
      assert.include(result.errors[0]?.message ?? "", "gh auth login --hostname ghe.acme.dev");
    }),
  );

  it.effect("returns project errors when every repository fails", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        Effect.fail(
          new GitHubApi.GitHubApiAuthenticationError({
            host: "github.com",
            operation: "listIssues",
          }),
        ),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const result = yield* service.list({ state: "open" });
      assert.deepStrictEqual(result.entries, []);
      assert.strictEqual(result.errors.length, 1);
    }),
  );

  it.effect("degrades malformed repository output", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        Effect.succeed("not-json"),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const result = yield* service.list({ state: "open" });
      assert.strictEqual(result.errors.length, 1);
      assert.include(result.errors[0]?.message ?? "", "unreadable issue data");
    }),
  );

  it.effect("fails the whole read when the host has no credential at all", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        Effect.fail(new GitHubCredentials.GitHubCliMissingError({ host: "github.com" })),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const error = yield* service.list({ state: "open" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubIssueCliMissingError");
    }),
  );

  it.effect("uses the selected project to read an issue from another repository", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        issueAnswer({
          ...issueRow(42),
          body: "Cross-repository issue",
          comments: { totalCount: 0, nodes: [] },
          closedAt: null,
        }),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const detail = yield* service.detail({
        projectId: "p1" as ProjectId,
        repository: "other/repo",
        number: 42,
      });

      assert.strictEqual(detail.repository, "other/repo");
      const call = graphql.mock.calls[0]?.[0];
      assert.deepStrictEqual(call?.variables, { owner: "other", name: "repo", number: 42 });
    }),
  );

  it.effect("returns the newest 100 comments while preserving the true count", () =>
    Effect.gen(function* () {
      // The read window is the newest 100 comments; totalCount says how many exist in full.
      const nodes = Array.from({ length: 100 }, (_, index) => commentNode(index + 2));
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        issueAnswer({
          ...issueRow(42),
          body: "Body",
          closedAt: null,
          comments: { totalCount: 101, nodes },
        }),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const detail = yield* service.detail({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 42,
      });

      assert.strictEqual(detail.commentCount, 101);
      assert.strictEqual(detail.comments.length, 100);
      assert.strictEqual(detail.comments[0]?.id, "comment-2");
      assert.strictEqual(detail.comments[99]?.id, "comment-101");
    }),
  );

  it.effect("loads issue detail and normalizes comment count", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        issueAnswer({
          ...issueRow(42),
          body: "Visible issue body",
          closedAt: null,
          comments: {
            totalCount: 1,
            nodes: [
              {
                id: "comment-1",
                author: { login: "reviewer" },
                body: "Please fix this.",
                createdAt: "2026-08-21T01:00:00Z",
                updatedAt: "2026-08-21T02:00:00Z",
                url: "https://github.com/acme/web/issues/42#issuecomment-comment-1",
              },
            ],
          },
        }),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const detail = yield* service.detail({
        projectId: "p1" as ProjectId,
        repository: "ACME/WEB",
        number: 42,
      });
      assert.strictEqual(detail.workspaceRoot, "/web");
      assert.strictEqual(detail.commentCount, 1);
      assert.strictEqual(detail.comments[0]?.updatedAt, "2026-08-21T02:00:00Z");
    }),
  );

  it.effect("closes with a reason and reopens without one", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>((call) =>
        String(call.query).includes("closeIssue")
          ? Effect.succeed(JSON.stringify({ data: { closeIssue: { issue: { id: "node-1" } } } }))
          : String(call.query).includes("reopenIssue")
            ? Effect.succeed(JSON.stringify({ data: { reopenIssue: { issue: { id: "node-1" } } } }))
            : issueIdAnswer("node-1"),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        graphql,
      );
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 42 };

      yield* service.setState({ ...reference, state: "closed", reason: "not planned" });
      yield* service.setState({ ...reference, state: "open", reason: "completed" });

      // Each press reads the node id, then mutates it.
      assert.strictEqual(graphql.mock.calls.length, 4);
      const closeMutation = graphql.mock.calls[1]?.[0];
      assert.include(closeMutation?.query ?? "", "closeIssue");
      assert.deepStrictEqual(closeMutation?.variables, {
        issueId: "node-1",
        stateReason: "NOT_PLANNED",
      });
      const reopenMutation = graphql.mock.calls[3]?.[0];
      assert.include(reopenMutation?.query ?? "", "reopenIssue");
      assert.deepStrictEqual(reopenMutation?.variables, { issueId: "node-1" });
    }),
  );

  it.effect("reports an unauthenticated close with the host to log in to", () =>
    Effect.gen(function* () {
      const graphql = vi.fn<GitHubApi.GitHubApi["Service"]["graphql"]>(() =>
        Effect.fail(
          new GitHubApi.GitHubApiAuthenticationError({
            host: "ghe.acme.dev",
            operation: "closeIssueId",
          }),
        ),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web", host: "ghe.acme.dev" })],
        graphql,
      );
      const error = yield* service
        .setState({
          projectId: "p1" as ProjectId,
          repository: "acme/web",
          number: 42,
          state: "closed",
        })
        .pipe(Effect.flip);

      assert.strictEqual(
        error._tag === "GitHubIssueCliUnauthenticatedError" ? error.host : null,
        "ghe.acme.dev",
      );
      // The refusal happens at the id read; no mutation is ever sent.
      assert.strictEqual(graphql.mock.calls.length, 1);
    }),
  );
});
