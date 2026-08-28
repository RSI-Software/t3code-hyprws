import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Folder, Globe, Globe2, History, RadioTower } from "lucide-react";

import type { BrowserBookmarkEntry, BrowserBookmarkScope } from "~/browserBookmarkStore";
import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewBookmarkCard } from "./PreviewBookmarkCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  projectBookmarks: ReadonlyArray<BrowserBookmarkEntry>;
  globalBookmarks: ReadonlyArray<BrowserBookmarkEntry>;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveBookmark: (scope: BrowserBookmarkScope, url: string) => void;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function PreviewEmptyState({
  threadRef,
  environmentId,
  configuredUrls,
  projectBookmarks,
  globalBookmarks,
  recentEntries,
  onRemoveBookmark,
  onRemoveRecent,
  onOpenUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  });
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);
  const project = projectBookmarks.filter((entry) => URL.canParse(entry.url));
  const global = globalBookmarks.filter((entry) => URL.canParse(entry.url));

  if (servers.length === 0 && recents.length === 0 && project.length === 0 && global.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>No preview yet</EmptyTitle>
        <EmptyDescription>
          Type a URL above, or run a dev script. Browser-ready localhost servers will show up here
          automatically.
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {project.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Folder className="size-4 shrink-0" />
              <h2 className="font-medium">Project bookmarks</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {project.map((entry) => (
                <PreviewBookmarkCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  scope="project"
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveBookmark("project", entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {global.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe2 className="size-4 shrink-0" />
              <h2 className="font-medium">Global bookmarks</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {global.map((entry) => (
                <PreviewBookmarkCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  scope="global"
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveBookmark("global", entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {recents.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">Recently used</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {servers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioTower className="size-4 shrink-0" />
              <h2 className="font-medium">Local servers</h2>
            </div>
            <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              Select a live local server to open it in this browser tab.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
