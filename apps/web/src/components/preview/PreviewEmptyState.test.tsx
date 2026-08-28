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

function server(port: number) {
  return {
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    requestedUrl: `http://localhost:${port}`,
    processName: "node",
    pid: 1,
    terminal: null,
    source: "scanner" as const,
  };
}

function render(recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>) {
  return renderToStaticMarkup(
    <PreviewEmptyState
      threadRef={threadRef}
      environmentId={environmentId}
      projectBookmarks={[]}
      globalBookmarks={[]}
      recentEntries={recentEntries}
      onRemoveBookmark={() => undefined}
      onRemoveRecent={() => undefined}
      onOpenUrl={() => undefined}
    />,
  );
}

describe("PreviewEmptyState", () => {
  it("renders a history entry in both groups when its host:port matches a live server", () => {
    mocks.servers = [server(5173)];
    const html = render([
      { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
    ]);
    expect(html).toContain("Recently used");
    expect(html).toContain("Local servers");
    expect(html).toContain("myapp.test/admin#users");
    expect(html).toContain("Admin");
    expect(html).toContain("Recent Local");
    expect(html).toContain("node");
  });

  it("renders only the recents group when no servers are found", () => {
    mocks.servers = [];
    const html = render([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(html).toContain("Recently used");
    expect(html).not.toContain("Local servers");
  });

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

  it("keeps the original empty state when both groups are empty", () => {
    mocks.servers = [];
    const html = render([]);
    expect(html).toContain("No preview yet");
  });

  it("renders an out-of-range lastVisitedAt entry without throwing", () => {
    mocks.servers = [];
    let html = "";
    expect(() => {
      html = render([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
    }).not.toThrow();
    expect(html).toContain("myapp.test");
    expect(html).toContain("Remove");
  });
});
