import { T } from "gt-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { parseUrl } from "@t3tools/shared/url";
import { Folder, Globe, Globe2, History, RadioTower } from "lucide-react";

import type { BrowserBookmarkEntry, BrowserBookmarkScope } from "~/browserBookmarkStore";
import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { DiscoveryList } from "../ui/discovery-list";

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
  const recents = recentEntries.filter((entry) => parseUrl(entry.url) !== null).slice(0, 8);
  const project = projectBookmarks.filter((entry) => parseUrl(entry.url) !== null); // fork-hook: browser-bookmarks/project-valid-urls
  const global = globalBookmarks.filter((entry) => parseUrl(entry.url) !== null); // fork-hook: browser-bookmarks/global-valid-urls

  if (servers.length === 0 && recents.length === 0 && project.length === 0 && global.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Globe className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>
          <T>No preview yet</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>
            Type a URL above, or run a dev script. Local servers this thread starts will show up
            here automatically.
          </T>
        </EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {project.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Folder className="size-4 shrink-0" />
              <h2 className="font-medium">Project bookmarks</h2>
            </div>
            <DiscoveryList>
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
            </DiscoveryList>
          </div>
        ) : null}
        {global.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe2 className="size-4 shrink-0" />
              <h2 className="font-medium">Global bookmarks</h2>
            </div>
            <DiscoveryList>
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
            </DiscoveryList>
          </div>
        ) : null}
        {recents.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <History className="size-4 shrink-0" />
              <h2 className="font-medium">
                <T>Recently used</T>
              </h2>
            </div>
            <DiscoveryList>
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  threadRef={threadRef}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </DiscoveryList>
          </div>
        ) : null}
        {servers.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RadioTower className="size-4 shrink-0" />
              <h2 className="font-medium">
                <T>Local servers</T>
              </h2>
            </div>
            <DiscoveryList>
              {servers.map((server) => (
                <PreviewLocalServerCard
                  key={`${server.host}:${server.port}`}
                  threadRef={threadRef}
                  server={server}
                  onOpen={() => onOpenUrl(server.requestedUrl)}
                />
              ))}
            </DiscoveryList>
            <p className="px-1 text-xs text-muted-foreground">
              <T>Select a live local server to open it in this browser tab.</T>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
