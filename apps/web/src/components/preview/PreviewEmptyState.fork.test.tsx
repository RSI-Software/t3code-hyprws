import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  servers: [] as Array<{
    host: string;
    port: number;
    url: string;
    requestedUrl: string;
    processName: string | null;
    pid: number | null;
    terminal: null;
    source: "scanner";
  }>,
}));

vi.mock("./useDiscoveredLocalServers", () => ({
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock("./PreviewFaviconIcon", () => ({
  PreviewFaviconIcon: () => <span data-favicon-icon />,
}));

import { PreviewEmptyState } from "./PreviewEmptyState";

const environmentId = EnvironmentId.make("env-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

describe("PreviewEmptyState", () => {
  it("renders project and global bookmarks before recent history", () => {
    mocks.servers = [];
    const html = renderToStaticMarkup(
      <PreviewEmptyState
        threadRef={threadRef}
        environmentId={environmentId}
        projectBookmarks={[
          { url: "https://project.test/docs", title: "Project docs", createdAt: 1 },
        ]}
        globalBookmarks={[{ url: "https://global.test/", title: "Global docs", createdAt: 2 }]}
        recentEntries={[{ url: "https://recent.test/", lastVisitedAt: 3 }]}
        onRemoveBookmark={() => undefined}
        onRemoveRecent={() => undefined}
        onOpenUrl={() => undefined}
      />,
    );

    expect(html).toContain("Project bookmarks");
    expect(html).toContain("Global bookmarks");
    expect(html.indexOf("Project bookmarks")).toBeLessThan(html.indexOf("Global bookmarks"));
    expect(html.indexOf("Global bookmarks")).toBeLessThan(html.indexOf("Recently used"));
  });
});
