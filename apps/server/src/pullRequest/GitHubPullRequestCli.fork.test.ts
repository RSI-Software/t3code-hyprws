import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
import { BASE_COMPARISON_GRAPHQL_QUERY } from "./gitHubPullRequestJson.ts";
const mockedExecute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();
const mockedGetPullRequest = vi.fn<GitHubCli.GitHubCli["Service"]["getPullRequest"]>();
const layer = it.layer(
  GitHubPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitHubCli.GitHubCli)({
        execute: mockedExecute,
        getPullRequest: mockedGetPullRequest,
      }),
    ),
    Layer.provide(GitHubGraphQlBudget.layer),
  ),
);
function output(stdout: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
    stdoutInvalidUtf8,
  };
}
function pullRequests(
  count: number,
  firstNumber: number,
  overrides: (number: number) => Readonly<Record<string, unknown>> = () => ({}),
): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: firstNumber + index,
      title: `Pull request ${firstNumber + index}`,
      url: `https://github.com/acme/web/pull/${firstNumber + index}`,
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      ...overrides(firstNumber + index),
    })),
  );
}
function pullRequestFiles(count: number, firstIndex: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      filename: `src/file${firstIndex + index}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    })),
  );
}
/** One thread's comments as the GraphQL read returns them, cursor and all. */
function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({ id, body: id, createdAt: "2026-07-01T00:00:00Z" })),
  };
}
function thread(id: string, ...commentIds: ReadonlyArray<string>) {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: threadComments(commentIds, null),
  };
}
function reviewThreadsPage(
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
        },
      },
    },
  });
}
function threadCommentsPage(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount: number,
  pullRequestId = "PR_7",
): string {
  return JSON.stringify({
    data: {
      repository: { pullRequest: { id: "PR_7" } },
      node: {
        pullRequest: { id: pullRequestId },
        comments: threadComments(ids, endCursor, totalCount),
      },
    },
  });
}
/** What `gh pr diff` answers on a pull request GitHub will not serve a diff for. */
const diffRefused = new GitHubCli.GitHubCliCommandError({
  command: "gh",
  cwd: "/w",
  cause: new Error("HTTP 406: the diff exceeded the maximum number of files (300)"),
});
/** The whole invocation the nth call made, so both argv and stdin can be asserted. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}
/** The one argument `--search` carries, which is where every listing filter ends up. */
function searchOfCall(index: number): string | undefined {
  const args = callAt(index).args;
  const flag = args.indexOf("--search");
  // Absent is its own answer: a read that carries no `--search` at all is what the fallback is.
  return flag === -1 ? undefined : args[flag + 1];
}
/** One row as a search answers it, which is the listing's row one connection deeper. */
function searchItem(number: number, repository: string, updatedAt: string) {
  return {
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: { login: "octocat", avatarUrl: "https://avatars/octocat" },
    headRefName: "feat/page",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    repository: { nameWithOwner: repository },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "hubot" } }] },
    labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  };
}
function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  return output(JSON.stringify({ data: { search: { pageInfo: { hasNextPage }, nodes } } }));
}
/** The search a batched read sent, which travels in the request body rather than in argv. */
function searchQueryOfCall(index: number): string | undefined {
  const body = JSON.parse(callAt(index).stdin ?? "{}") as {
    variables?: {
      q?: string;
    };
  };
  return body.variables?.q;
}
afterEach(() => {
  mockedExecute.mockReset();
  mockedGetPullRequest.mockReset();
});
layer("GitHubPullRequestCli.layer", (it) => {
  it("normalizes image output to the original file name", () => {
    expect(
      GitHubPullRequestCli.parseGitHubAttachmentUploadOutput({
        stdout:
          "![pending.png](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456)\n",
        name: "before [ mid ] after.png",
        mimeType: "image/png",
      }),
    ).toBe(
      "![before \\[ mid \\] after.png](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456)",
    );
  });
  it.effect("uses the pinned extension without forwarding an ambient session token", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output("gh-image 1.2.0\n")))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n",
            ),
          ),
        );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const insertion = yield* cli.uploadAttachment({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        path: "/tmp/demo.webm",
        name: "demo.webm",
        mimeType: "video/webm",
      });
      expect(insertion).toBe(
        "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
      );
      expect(callAt(0)).toMatchObject({
        args: ["image", "--version"],
        env: { GH_SESSION_TOKEN: undefined },
      });
      expect(callAt(1)).toMatchObject({
        args: ["image", "--repo", "acme/web", "/tmp/demo.webm"],
        env: { GH_SESSION_TOKEN: undefined },
      });
    }),
  );
  it.effect("refuses extension version drift before uploading bytes to GitHub", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("gh-image 1.3.0\n")));
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const error = yield* Effect.flip(
        cli.uploadAttachment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          path: "/tmp/demo.png",
          name: "demo.png",
          mimeType: "image/png",
        }),
      );
      expect(error._tag).toBe("GitHubAttachmentUploadError");
      assert(error._tag === "GitHubAttachmentUploadError");
      expect(error.detail).toContain("received gh-image 1.3.0");
      expect(error.detail).toContain("gh extension install drogers0/gh-image --pin v1.2.0");
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("names the missing extension and how to install it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.fail(
          new GitHubCli.GitHubCliCommandError({
            command: "gh",
            cwd: "/w",
            cause: new Error('unknown command "image" for "gh"'),
          }),
        ),
      );
      const cli = yield* GitHubPullRequestCli.GitHubPullRequestCli;
      const error = yield* Effect.flip(
        cli.uploadAttachment({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          path: "/tmp/demo.png",
          name: "demo.png",
          mimeType: "image/png",
        }),
      );
      assert(error._tag === "GitHubAttachmentUploadError");
      expect(error.detail).toContain("gh-image extension is not installed");
      expect(error.detail).toContain("gh extension install drogers0/gh-image --pin v1.2.0");
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );
});
