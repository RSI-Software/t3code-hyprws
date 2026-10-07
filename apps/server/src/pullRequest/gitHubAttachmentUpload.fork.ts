/**
 * Pull request media upload through the pinned `gh-image` extension, behind
 * `GitHubPullRequestCli.uploadAttachment`.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type * as GitHubApi from "../sourceControl/GitHubApi.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

export class GitHubAttachmentUploadError extends Schema.TaggedError<GitHubAttachmentUploadError>()(
  "GitHubAttachmentUploadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub CLI failed in uploadAttachment: ${this.detail}`;
  }
}

const GITHUB_IMAGE_EXTENSION_VERSION = "gh-image 1.2.0";
/** 1.3.0 uploads under the `gh` token's account before the browser session, so the pin is exact. */
const GITHUB_IMAGE_INSTALL_HINT =
  "Install it on the server with `gh extension install drogers0/gh-image --pin v1.2.0`.";
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const ATTACHMENT_UPLOAD_MAX_OUTPUT_BYTES = 4_096;
const GITHUB_ATTACHMENT_URL_PATTERN =
  "https://github.com/user-attachments/assets/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GITHUB_ATTACHMENT_URL = new RegExp(`^${GITHUB_ATTACHMENT_URL_PATTERN}$`, "i");
const GITHUB_IMAGE_MARKDOWN = new RegExp(
  `^!\\[[^\\r\\n]*\\]\\((${GITHUB_ATTACHMENT_URL_PATTERN})\\)$`,
  "i",
);

function markdownImageAlt(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

export function parseGitHubAttachmentUploadOutput(input: {
  readonly stdout: string;
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const output = input.stdout.trim();
  if (input.mimeType.startsWith("image/")) {
    const url = GITHUB_IMAGE_MARKDOWN.exec(output)?.[1];
    return url ? `![${markdownImageAlt(input.name)}](${url})` : null;
  }
  return GITHUB_ATTACHMENT_URL.test(output) ? output : null;
}

export const uploadGitHubAttachment = (
  {
    api,
    vcsProcess,
  }: {
    readonly api: GitHubApi.GitHubApi["Service"];
    readonly vcsProcess: VcsProcess.VcsProcess["Service"];
  },
  input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
  },
) => {
  if (input.host !== "github.com") {
    return Effect.fail(
      new GitHubAttachmentUploadError({
        command: "gh",
        cwd: input.cwd,
        detail: "Attachments through gh image are supported only on github.com.",
      }),
    );
  }
  return api.credential(input.host).pipe(
    Effect.flatMap(({ token }) => {
      // The extension is host-agnostic and its owner/name repository cannot prove a host in
      // argv, so the token comes from `credential`, which refuses any host the caller did
      // not verify.
      const ghToken = Redacted.value(token);
      // The pinned extension version uploads under the browser session when it finds one,
      // so the session variable is removed rather than inherited and only the token speaks.
      const environment = {
        GH_SESSION_TOKEN: undefined,
        GH_HOST: input.host,
        GH_TOKEN: ghToken,
        GITHUB_TOKEN: ghToken,
      };
      const runGhImage = (call: {
        readonly args: ReadonlyArray<string>;
        readonly timeoutMs?: number | undefined;
        readonly failureDetail: string;
      }) =>
        vcsProcess
          .run({
            operation: "GitHubPullRequestCli.uploadAttachment",
            command: "gh",
            args: call.args,
            cwd: input.cwd,
            env: environment,
            maxOutputBytes: ATTACHMENT_UPLOAD_MAX_OUTPUT_BYTES,
            ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
          })
          .pipe(
            Effect.mapError(
              (cause): GitHubAttachmentUploadError =>
                new GitHubAttachmentUploadError({
                  command: "gh",
                  cwd: input.cwd,
                  detail: call.failureDetail,
                  cause,
                }),
            ),
          );
      return runGhImage({
        args: ["image", "--version"],
        // `gh` exits non-zero on an unknown subcommand, which is what a missing extension is.
        failureDetail: `The gh-image extension is not installed. ${GITHUB_IMAGE_INSTALL_HINT}`,
      }).pipe(
        Effect.flatMap((version) =>
          version.stdout.trim() === GITHUB_IMAGE_EXTENSION_VERSION
            ? runGhImage({
                args: ["image", "--repo", input.repository, input.path],
                timeoutMs: ATTACHMENT_UPLOAD_TIMEOUT_MS,
                failureDetail: "gh image failed to upload the attachment.",
              })
            : Effect.fail(
                new GitHubAttachmentUploadError({
                  command: "gh",
                  cwd: input.cwd,
                  detail: `Expected ${GITHUB_IMAGE_EXTENSION_VERSION}; received ${version.stdout.trim() || "no version"}. ${GITHUB_IMAGE_INSTALL_HINT}`,
                }),
              ),
        ),
        Effect.flatMap((result) => {
          const insertion = parseGitHubAttachmentUploadOutput({
            stdout: result.stdout,
            name: input.name,
            mimeType: input.mimeType,
          });
          return insertion
            ? Effect.succeed(insertion)
            : Effect.fail(
                new GitHubAttachmentUploadError({
                  command: "gh",
                  cwd: input.cwd,
                  detail: "gh image returned an invalid attachment URL.",
                }),
              );
        }),
      );
    }),
  ); // fork-hook: upstream-fixes/attachment-media-verified-host
};
