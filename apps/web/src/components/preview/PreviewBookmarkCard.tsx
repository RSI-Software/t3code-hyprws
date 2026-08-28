import type { ScopedThreadRef } from "@t3tools/contracts";
import { X } from "lucide-react";

import type { BrowserBookmarkEntry, BrowserBookmarkScope } from "~/browserBookmarkStore";
import { Button } from "~/components/ui/button";
import { DiscoveryListRow } from "~/components/ui/discovery-list";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";

interface Props {
  threadRef: ScopedThreadRef;
  entry: BrowserBookmarkEntry;
  scope: BrowserBookmarkScope;
  onOpen: () => void;
  onRemove: () => void;
}

export function PreviewBookmarkCard({ threadRef, entry, scope, onOpen, onRemove }: Props) {
  const parsed = new URL(entry.url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  return (
    <div className="group relative flex w-full items-center">
      <DiscoveryListRow
        onClick={onOpen}
        icon={<PreviewFaviconIcon threadRef={threadRef} url={entry.url} />}
        title={entry.title ?? label}
        description={entry.title ? label : null}
        action={<span aria-hidden="true" className="w-8 shrink-0" />}
      />
      <div className="absolute right-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={`Remove ${label} from ${scope} bookmarks`}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
