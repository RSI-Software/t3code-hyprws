import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  PullRequestActionInput,
  PullRequestAttachmentCreateUploadUrlInput,
  PullRequestCapabilities,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestReviewerRequestInput,
  resolvePullRequestAuthorFilter,
} from "./pullRequest.ts";
const decodeListResult = Schema.decodeUnknownSync(PullRequestListResult);
const decodeListInput = Schema.decodeUnknownSync(PullRequestListInput);
const decodeReviewerRequest = Schema.decodeUnknownSync(PullRequestReviewerRequestInput);
const decodeAttachmentUpload = Schema.decodeUnknownSync(PullRequestAttachmentCreateUploadUrlInput);
const LIST_RESULT: PullRequestListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: "github",
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: "gitlab",
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: "github",
      host: "github.com",
      projectId: "project-1" as PullRequestListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 1,
      title: "Add a pull requests page",
      url: "https://github.com/pingdotgg/t3code/pull/1",
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      viewerReviewRequested: false,
      labels: [{ name: "backend", color: null }],
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|1" },
};
describe("PullRequestAttachmentCreateUploadUrlInput", () => {
  it("accepts GitHub image and video media within the common 10 MB limit", () => {
    const base = { projectId: "project-1", repository: "acme/web", number: 7 };
    expect(
      decodeAttachmentUpload({
        ...base,
        name: "demo.webm",
        mimeType: "video/webm",
        sizeBytes: 10 * 1024 * 1024,
      }).mimeType,
    ).toBe("video/webm");
    expect(() =>
      decodeAttachmentUpload({
        ...base,
        name: "demo.webm",
        mimeType: "video/webm",
        sizeBytes: 10 * 1024 * 1024 + 1,
      }),
    ).toThrow();
  });
});
