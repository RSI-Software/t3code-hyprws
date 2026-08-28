import { describe, expect, it } from "vite-plus/test";

import { pullRequestAttachmentMimeType } from "~/lib/pullRequestAttachmentUpload";

import { insertPullRequestAttachment } from "./PullRequestMarkdownEditor";

describe("insertPullRequestAttachment", () => {
  it("replaces the selected text and keeps markdown on its own line", () => {
    expect(insertPullRequestAttachment("Before replace after", "![demo](url)", 7, 14)).toEqual({
      value: "Before \n\n![demo](url)\n\n after",
      cursor: 23,
    });
  });

  it("inserts at the end without an unnecessary trailing blank line", () => {
    expect(insertPullRequestAttachment("Before", "https://example.test/video", 6, 6)).toEqual({
      value: "Before\n\nhttps://example.test/video",
      cursor: 34,
    });
  });
});

describe("pullRequestAttachmentMimeType", () => {
  it("accepts the supported browser MIME type", () => {
    expect(pullRequestAttachmentMimeType({ name: "recording.webm", type: "video/webm" })).toBe(
      "video/webm",
    );
  });

  it("recovers a missing browser MIME type from the file extension", () => {
    expect(pullRequestAttachmentMimeType({ name: "recording.MOV", type: "" })).toBe(
      "video/quicktime",
    );
  });
});
