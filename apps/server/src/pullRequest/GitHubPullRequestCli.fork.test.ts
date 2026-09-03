import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as GitHubPullRequestCli from "./GitHubPullRequestCli.ts";
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
/** One thread's comments as the GraphQL read returns them, cursor and all. */
/** What `gh pr diff` answers on a pull request GitHub will not serve a diff for. */
/** The whole invocation the nth call made, so both argv and stdin can be asserted. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}
/** The one argument `--search` carries, which is where every listing filter ends up. */
/** One row as a search answers it, which is the listing's row one connection deeper. */
/** The search a batched read sent, which travels in the request body rather than in argv. */
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
