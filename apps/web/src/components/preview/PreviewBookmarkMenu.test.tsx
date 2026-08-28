import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewBookmarkMenu } from "./PreviewBookmarkMenu";

describe("PreviewBookmarkMenu", () => {
  it("renders an unpressed star for an unbookmarked page", () => {
    const markup = renderToStaticMarkup(
      <PreviewBookmarkMenu
        scope={null}
        projectAvailable
        onScopeChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Bookmark this page"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("fill-current");
  });

  it("renders a filled pressed star for a project bookmark", () => {
    const markup = renderToStaticMarkup(
      <PreviewBookmarkMenu
        scope="project"
        projectAvailable
        onScopeChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Edit project bookmark"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("fill-current");
  });
});
