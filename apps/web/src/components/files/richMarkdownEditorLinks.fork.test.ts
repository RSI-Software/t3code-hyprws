import { describe, expect, it } from "vite-plus/test";

import { resolveRichMarkdownEditorLinkMeta } from "./richMarkdownEditorLinks";

describe("rich Markdown editor links", () => {
  it("resolves document-relative links inside the workspace", () => {
    expect(
      resolveRichMarkdownEditorLinkMeta(
        "../../README.md#L12",
        "/workspace",
        "/workspace/docs/user",
      ),
    ).toMatchObject({
      filePath: "/workspace/README.md",
      targetPath: "/workspace/README.md:12",
      displayPath: "workspace/README.md:12",
      workspaceRelativePath: "README.md",
      basename: "README.md",
      line: 12,
    });
  });

  it("does not claim a document-relative link that escapes the workspace", () => {
    expect(
      resolveRichMarkdownEditorLinkMeta(
        "../../../outside.md",
        "/workspace",
        "/workspace/docs/user",
      ),
    ).toMatchObject({
      filePath: "/outside.md",
      workspaceRelativePath: null,
    });
  });

  it("normalizes Windows document-relative links and preserves their path style", () => {
    expect(
      resolveRichMarkdownEditorLinkMeta("../README.md", "C:/workspace", "C:/workspace/docs"),
    ).toMatchObject({
      filePath: "C:\\workspace\\README.md",
      workspaceRelativePath: "README.md",
    });
    expect(
      resolveRichMarkdownEditorLinkMeta(
        "../README.md#L4",
        "\\\\server\\share\\workspace",
        "\\\\server\\share\\workspace\\docs",
      ),
    ).toMatchObject({
      filePath: "\\\\server\\share\\workspace\\README.md",
      targetPath: "\\\\server\\share\\workspace\\README.md:4",
      workspaceRelativePath: "README.md",
      line: 4,
    });
  });

  it("delegates external URLs to the shared non-file boundary", () => {
    expect(
      resolveRichMarkdownEditorLinkMeta(
        "https://example.com/guide.md",
        "/workspace",
        "/workspace/docs",
      ),
    ).toBeNull();
  });
});
