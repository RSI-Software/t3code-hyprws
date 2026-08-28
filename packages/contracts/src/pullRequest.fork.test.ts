import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestAttachmentCreateUploadUrlInput } from "./pullRequest.ts";
const decodeAttachmentUpload = Schema.decodeUnknownSync(PullRequestAttachmentCreateUploadUrlInput);
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
