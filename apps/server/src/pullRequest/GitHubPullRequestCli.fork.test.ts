// Fork-owned: the attachment media upload, moved onto the API service's verified
// credential and a direct `gh image` run now that GitHubCli carries no raw command
// execution (upstream-fixes/attachment-media-verified-host).
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Redacted from "effect/Redacted";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import { parseGitHubAttachmentUploadOutput } from "./gitHubAttachmentUpload.fork.ts";

const mockedRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const mockedCredential = vi.fn<GitHubApi.GitHubApi["Service"]["credential"]>(() =>
  Effect.succeed({ token: Redacted.make("token"), fingerprint: "github.com:token" }),
);
const mockApi = Layer.succeed(
  GitHubApi.GitHubApi,
  GitHubApi.GitHubApi.of({
    graphql: () => Effect.die("unused"),
    rest: () => Effect.die("unused"),
    credential: (host) => mockedCredential(host),
  }),
);
const layer = it.layer(
  GitHubPullRequestApi.layer.pipe(
    Layer.provide(mockApi),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run: mockedRun })),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

/** The whole invocation the nth call made, so argv and env can be asserted. */
function callAt(index: number) {
  const call = mockedRun.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

const upload = (
  input: Partial<
    Parameters<GitHubPullRequestApi.GitHubPullRequestApi["Service"]["uploadAttachment"]>[0]
  > = {},
) =>
  Effect.flatMap(GitHubPullRequestApi.GitHubPullRequestApi, (cli) =>
    cli.uploadAttachment({
      cwd: "/w",
      repository: "acme/web",
      host: "github.com",
      path: "/tmp/demo.webm",
      name: "demo.webm",
      mimeType: "video/webm",
      ...input,
    }),
  );

afterEach(() => {
  mockedRun.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockReturnValue(
    Effect.succeed({ token: Redacted.make("token"), fingerprint: "github.com:token" }),
  );
});

layer("GitHubPullRequestApi.layer", (it) => {
  it("normalizes image output to the original file name", () => {
    expect(
      parseGitHubAttachmentUploadOutput({
        stdout:
          "![pending.png](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456)\n",
        name: "before [ mid ] after.png",
        mimeType: "image/png",
      }),
    ).toBe(
      "![before \\[ mid \\] after.png](https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456)",
    );
  });
  it.effect("uploads under the credential verified for the host, never a session token", () =>
    Effect.gen(function* () {
      mockedRun
        .mockReturnValueOnce(Effect.succeed(output("gh-image 1.2.0\n")))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456\n",
            ),
          ),
        );
      const insertion = yield* upload();

      expect(insertion).toBe(
        "https://github.com/user-attachments/assets/2f8c1a90-1b2c-4d5e-8f90-abcdef123456",
      );
      // The token is fetched for the caller's host, which is where a pinned page's
      // host check happens.
      expect(mockedCredential).toHaveBeenCalledWith("github.com");
      assert.isDefined(callAt(0));
      expect(callAt(0)).toMatchObject({
        command: "gh",
        args: ["image", "--version"],
        env: { GH_SESSION_TOKEN: undefined, GH_HOST: "github.com", GH_TOKEN: "token" },
      });
      expect(callAt(1)).toMatchObject({
        args: ["image", "--repo", "acme/web", "/tmp/demo.webm"],
        env: { GH_SESSION_TOKEN: undefined, GH_HOST: "github.com", GH_TOKEN: "token" },
      });
    }),
  );
  it.effect("refuses extension version drift before uploading bytes to GitHub", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(Effect.succeed(output("gh-image 1.3.0\n")));
      const error = yield* Effect.flip(upload({ mimeType: "image/png", name: "demo.png" }));
      expect(error._tag).toBe("GitHubAttachmentUploadError");
      assert(error._tag === "GitHubAttachmentUploadError");
      expect(error.detail).toContain("received gh-image 1.3.0");
      expect(error.detail).toContain("gh extension install drogers0/gh-image --pin v1.2.0");
      expect(mockedRun).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("names the missing extension and how to install it", () =>
    Effect.gen(function* () {
      mockedRun.mockReturnValueOnce(
        Effect.fail(
          new VcsProcessExitError({
            operation: "GitHubPullRequestApi.uploadAttachment",
            command: "gh",
            cwd: "/w",
            exitCode: 1,
            detail: 'unknown command "image" for "gh"',
          }),
        ),
      );
      const error = yield* Effect.flip(upload({ mimeType: "image/png", name: "demo.png" }));
      assert(error._tag === "GitHubAttachmentUploadError");
      expect(error.detail).toContain("gh-image extension is not installed");
      expect(error.detail).toContain("gh extension install drogers0/gh-image --pin v1.2.0");
      expect(mockedRun).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("refuses the upload when no credential is verified for the host", () =>
    Effect.gen(function* () {
      // The refusal is GitHubApi.credential's own: a pinned page for another host, a disabled
      // host, or a missing token all land here, and no extension bytes ever upload.
      mockedCredential.mockReturnValue(
        Effect.fail(
          new GitHubApi.GitHubApiAuthenticationError({
            host: "github.com",
            operation: "credential",
          }),
        ),
      );
      const error = yield* Effect.flip(upload({ mimeType: "image/png", name: "demo.png" }));
      expect(error._tag).toBe("GitHubApiAuthenticationError");
      expect(mockedRun).not.toHaveBeenCalled();
    }),
  );
});
