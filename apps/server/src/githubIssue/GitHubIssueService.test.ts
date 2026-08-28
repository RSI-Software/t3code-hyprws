import { assert, describe, it, vi } from "@effect/vitest";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
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

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function issue(number: number, updatedAt = "2026-08-21T00:00:00Z") {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    author: { login: "octocat", name: null },
    assignees: [],
    labels: [],
    state: "OPEN",
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt,
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
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects,
              threads: [],
              updatedAt: "2026-08-21T00:00:00Z",
            }),
        }),
      ),
    ),
  );
}

describe("GitHubIssueService", () => {
  it.effect("composes --state and --search while discovering only GitHub projects", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output(JSON.stringify([issue(2), issue(1)]))),
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
        execute,
      );

      yield* service.list({ state: "open", query: "websocket", limit: 1 });

      assert.strictEqual(execute.mock.calls.length, 1);
      assert.deepStrictEqual(execute.mock.calls[0]?.[0].args, [
        "issue",
        "list",
        "--repo",
        "github.com/acme/web",
        "--state",
        "open",
        "--limit",
        "2",
        "--json",
        "number,title,url,author,assignees,labels,issueType,state,createdAt,updatedAt,comments,reactionGroups",
        "--search",
        "websocket sort:updated-desc",
      ]);
    }),
  );

  it.effect("sends sort:updated-desc when no user query is present", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output("[]")),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
      );
      yield* service.list({ state: "all" });
      const args = execute.mock.calls[0]?.[0].args ?? [];
      assert.deepStrictEqual(args.slice(-2), ["--search", "sort:updated-desc"]);
    }),
  );

  it.effect("uses host-qualified Enterprise repositories", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output("[]")),
      );
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
        execute,
      );
      yield* service.list({ state: "open" });
      const args = execute.mock.calls[0]?.[0].args ?? [];
      assert.strictEqual(args[args.indexOf("--repo") + 1], "ghe.acme.dev/acme/internal");
    }),
  );

  it.effect("applies project filtering before repository de-duplication", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output(JSON.stringify([issue(7)]))),
      );
      const service = yield* makeService(
        [
          project({ id: "p1", title: "first", workspaceRoot: "/first" }),
          project({ id: "p2", title: "selected", workspaceRoot: "/selected" }),
        ],
        execute,
      );
      const result = yield* service.list({ state: "open", projectId: "p2" as ProjectId });
      assert.strictEqual(execute.mock.calls[0]?.[0].cwd, "/selected");
      assert.strictEqual(result.entries[0]?.projectId, "p2");
    }),
  );

  it.effect("sorts mixed timezone offsets by instant and limits globally", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
        Effect.succeed(
          output(
            JSON.stringify(
              input.cwd === "/web"
                ? [issue(1, "2026-08-21T03:30:00+02:00")]
                : [issue(2, "2026-08-21T02:00:00Z")],
            ),
          ),
        ),
      );
      const service = yield* makeService(
        [
          project({ id: "p1", title: "web", workspaceRoot: "/web" }),
          project({ id: "p2", title: "api", workspaceRoot: "/api", repository: "acme/api" }),
        ],
        execute,
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
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output(JSON.stringify([issue(3), issue(2), issue(1)]))),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
      );
      const result = yield* service.list({ state: "open", limit: 2 });
      assert.strictEqual(result.entries.length, 2);
      assert.strictEqual(result.truncated, true);
    }),
  );

  it.effect("keeps healthy rows when one host is unauthenticated", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
        input.cwd === "/enterprise"
          ? Effect.fail(
              new GitHubCli.GitHubCliAuthenticationError({
                command: "gh",
                cwd: input.cwd,
                cause: new Error("gh auth login"),
              }),
            )
          : Effect.succeed(output(JSON.stringify([issue(7)]))),
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
        execute,
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
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
        Effect.fail(
          new GitHubCli.GitHubCliAuthenticationError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error("gh auth login"),
          }),
        ),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
      );
      const result = yield* service.list({ state: "open" });
      assert.deepStrictEqual(result.entries, []);
      assert.strictEqual(result.errors.length, 1);
    }),
  );

  it.effect("degrades malformed repository output", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output("not-json")),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
      );
      const result = yield* service.list({ state: "open" });
      assert.strictEqual(result.errors.length, 1);
      assert.include(result.errors[0]?.message ?? "", "unreadable issue data");
    }),
  );

  it.effect("fails the whole read when the GitHub CLI is missing", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>((input) =>
        Effect.fail(
          new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error("spawn gh ENOENT"),
          }),
        ),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
      );
      const error = yield* service.list({ state: "open" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubIssueCliMissingError");
    }),
  );

  it.effect("rejects detail repository mismatch before invoking gh", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(output("{}")),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
      );
      const error = yield* service
        .detail({
          projectId: "p1" as ProjectId,
          repository: "attacker/other",
          number: 42,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubIssueOperationError");
      assert.strictEqual(execute.mock.calls.length, 0);
    }),
  );

  it.effect("returns the newest 100 comments while preserving the true count", () =>
    Effect.gen(function* () {
      const comments = Array.from({ length: 101 }, (_, index) => ({
        id: `comment-${index + 1}`,
        author: null,
        body: `Comment ${index + 1}`,
        createdAt: `2026-08-21T01:${String(index % 60).padStart(2, "0")}:00Z`,
        updatedAt: `2026-08-21T02:${String(index % 60).padStart(2, "0")}:00Z`,
        url: `https://github.com/acme/web/issues/42#issuecomment-${index + 1}`,
      }));
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(
          output(JSON.stringify({ ...issue(42), body: "Body", closedAt: null, comments })),
        ),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
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
      const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>(() =>
        Effect.succeed(
          output(
            JSON.stringify({
              ...issue(42),
              body: "Visible issue body",
              closedAt: null,
              comments: [
                {
                  id: "comment-1",
                  author: { login: "reviewer" },
                  body: "Please fix this.",
                  createdAt: "2026-08-21T01:00:00Z",
                  updatedAt: "2026-08-21T02:00:00Z",
                  url: "https://github.com/acme/web/issues/42#issuecomment-comment-1",
                },
              ],
            }),
          ),
        ),
      );
      const service = yield* makeService(
        [project({ id: "p1", title: "web", workspaceRoot: "/web" })],
        execute,
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
});
