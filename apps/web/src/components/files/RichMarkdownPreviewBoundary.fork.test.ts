import { describe, expect, it, vi } from "vite-plus/test";

import {
  publishRichMarkdownChange,
  resolveRichMarkdownPreviewMode,
} from "./RichMarkdownPreviewBoundary";

describe("rich Markdown preview boundary", () => {
  it("enters the rich editor only for a ready editable Markdown document", () => {
    expect(
      resolveRichMarkdownPreviewMode({
        relativePath: "docs/guide.md",
        fileState: "ready",
        renderPreferred: true,
        revealHandled: true,
        readOnly: false,
      }),
    ).toMatchObject({
      isMarkdown: true,
      isRichMarkdown: true,
      rendered: true,
      richEditorEnabled: true,
      toggleDisabled: false,
      toggleLabel: "Show markdown source",
    });
  });

  it("keeps MDX and host files outside the rich editor", () => {
    const mdx = resolveRichMarkdownPreviewMode({
      relativePath: "docs/guide.mdx",
      fileState: "ready",
      renderPreferred: true,
      revealHandled: true,
      readOnly: false,
    });
    const hostMarkdown = resolveRichMarkdownPreviewMode({
      relativePath: "/tmp/guide.md",
      fileState: "ready",
      renderPreferred: true,
      revealHandled: true,
      readOnly: true,
    });

    expect(mdx).toMatchObject({
      isRichMarkdown: false,
      rendered: true,
      richEditorEnabled: false,
    });
    expect(hostMarkdown).toMatchObject({
      isRichMarkdown: false,
      rendered: true,
      richEditorEnabled: false,
    });
  });

  it("describes the read-only host-file transition as a rendered preview", () => {
    expect(
      resolveRichMarkdownPreviewMode({
        relativePath: "/tmp/guide.md",
        fileState: "ready",
        renderPreferred: false,
        revealHandled: true,
        readOnly: true,
      }),
    ).toMatchObject({
      isRichMarkdown: false,
      rendered: false,
      toggleLabel: "Show rendered markdown",
      tooltipLabel: "Show rendered markdown",
    });
  });

  it("forces source for line reveals and disables truncated rich editing", () => {
    const reveal = resolveRichMarkdownPreviewMode({
      relativePath: "README.md",
      fileState: "ready",
      renderPreferred: true,
      revealHandled: false,
      readOnly: false,
    });
    const truncated = resolveRichMarkdownPreviewMode({
      relativePath: "README.md",
      fileState: "truncated",
      renderPreferred: true,
      revealHandled: true,
      readOnly: false,
    });

    expect(reveal).toMatchObject({ rendered: false, richEditorEnabled: false });
    expect(truncated).toMatchObject({
      rendered: false,
      richEditorEnabled: false,
      toggleDisabled: true,
      tooltipLabel: "Rich editing is unavailable for truncated files",
    });
    expect(
      resolveRichMarkdownPreviewMode({
        relativePath: "docs/guide.mdx",
        fileState: "truncated",
        renderPreferred: true,
        revealHandled: true,
        readOnly: false,
      }).tooltipLabel,
    ).toBe("Rendered preview is unavailable for truncated files");
  });

  it("publishes changed Markdown through the optimistic save boundary", () => {
    const setOptimistic = vi.fn();
    const save = vi.fn();

    expect(
      publishRichMarkdownChange({
        nextContents: "# Updated\n",
        currentContents: "# Original\n",
        setOptimistic,
        save,
      }),
    ).toBe(true);
    expect(setOptimistic).toHaveBeenCalledWith("# Updated\n");
    expect(save).toHaveBeenCalledWith("# Updated\n");

    setOptimistic.mockClear();
    save.mockClear();
    expect(
      publishRichMarkdownChange({
        nextContents: "# Updated\n",
        currentContents: "# Updated\n",
        setOptimistic,
        save,
      }),
    ).toBe(false);
    expect(setOptimistic).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves ordinary files outside the Markdown mode boundary", () => {
    expect(
      resolveRichMarkdownPreviewMode({
        relativePath: "src/index.ts",
        fileState: "ready",
        renderPreferred: true,
        revealHandled: true,
        readOnly: false,
      }),
    ).toMatchObject({
      isMarkdown: false,
      isRichMarkdown: false,
      rendered: false,
      richEditorEnabled: false,
      toggleDisabled: false,
    });
  });
});
