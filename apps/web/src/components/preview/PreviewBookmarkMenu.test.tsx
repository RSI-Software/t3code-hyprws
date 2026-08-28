import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Menu } from "~/components/ui/menu";

import { PreviewBookmarkMenu, PreviewBookmarkMenuContent } from "./PreviewBookmarkMenu";

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

  it("renders the scope choices inside their radio group context", () => {
    const markup = renderToStaticMarkup(
      <Menu>
        <PreviewBookmarkMenuContent
          scope={null}
          projectAvailable
          onScopeChange={vi.fn()}
          onRemove={vi.fn()}
        />
      </Menu>,
    );

    expect(markup).toContain("Save page to");
    expect(markup).toContain("Project bookmarks");
    expect(markup).toContain("Global bookmarks");
  });
});
