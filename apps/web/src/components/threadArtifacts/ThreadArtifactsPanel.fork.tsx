import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadArtifactLink } from "@t3tools/contracts";
import { ArrowUpRightIcon, CopyIcon, MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { PULL_REQUEST_ROW_CLASS, PullRequestRowLines } from "../pullRequest/PullRequestListRow";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadArtifactIconFork } from "./ThreadArtifactBadge.fork";
import {
  openThreadArtifactFork,
  ThreadArtifactsTabIconFork,
  useThreadWorkspaceRootFork,
  useUnlinkThreadArtifactFork,
} from "./threadArtifacts.fork";

const SOURCE_LABELS: Record<ThreadArtifactLink["source"], string> = {
  manual: "Linked by you",
  agent: "Linked by the agent",
};

/** The thread's Artifacts panel, laid out like its Linked issues panel. */
export function ThreadArtifactsPanelFork({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const workspaceRoot = useThreadWorkspaceRootFork(threadRef);
  const unlink = useUnlinkThreadArtifactFork();
  const links = (thread?.artifacts ?? []).toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  const unlinkArtifact = async (link: ThreadArtifactLink) => {
    const result = await unlink(threadRef, link.path);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not unlink ${link.title}`,
      description: failure instanceof Error ? failure.message : undefined,
    });
  };

  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <ThreadArtifactsTabIconFork aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No artifacts</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Trackers, plans, and notes the agent links to this thread land here and stay current as it
          edits them.
        </p>
      </div>
    );
  }

  const missingCount = links.filter((link) => link.missing).length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {links.map((link) => (
          <ArtifactRow
            key={link.path}
            link={link}
            onOpen={() => openThreadArtifactFork(threadRef, link, workspaceRoot)}
            onUnlink={() => void unlinkArtifact(link)}
          />
        ))}
      </div>
      <footer className="flex items-center border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        {links.length} linked
        {missingCount > 0 ? ` · ${missingCount} missing` : ""}
      </footer>
    </div>
  );
}

function ArtifactRow({
  link,
  onOpen,
  onUnlink,
}: {
  readonly link: ThreadArtifactLink;
  readonly onOpen: () => void;
  readonly onUnlink: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuAnchor = menuPosition
    ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
    : undefined;
  return (
    <div
      className={cn(PULL_REQUEST_ROW_CLASS, "relative pl-2 hover:bg-accent/60")}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
    >
      <ThreadArtifactIconFork
        path={link.path}
        className={cn("size-4 shrink-0", link.missing && "text-muted-foreground/60")}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 text-left" />
          }
        >
          <PullRequestRowLines
            number={null}
            title={
              <span className={cn(link.missing && "text-muted-foreground line-through")}>
                {link.title}
              </span>
            }
            status={
              link.missing ? (
                <Badge size="sm" variant="warning">
                  Missing
                </Badge>
              ) : null
            }
            meta={
              <span className="flex min-w-0 font-mono">
                <MiddleTruncate value={link.path} showTitle={false} />
              </span>
            }
            updatedAt={link.updatedAt}
          />
        </TooltipTrigger>
        <TooltipPopup className="max-w-96 break-all">
          {SOURCE_LABELS[link.source]} · {link.path}
        </TooltipPopup>
      </Tooltip>
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden controls would intercept taps on touch screens.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
        )}
      >
        <span aria-hidden className="absolute inset-0 bg-accent/60" />
        <Menu
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) setMenuPosition(null);
          }}
        >
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Actions for ${link.title}`}
                className="relative"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup
            anchor={menuAnchor}
            align={menuPosition ? "start" : "end"}
            side="bottom"
            sideOffset={menuPosition ? 0 : 4}
          >
            <MenuItem onClick={onOpen}>
              <ArrowUpRightIcon className="size-3.5" />
              Open
            </MenuItem>
            <MenuItem onClick={() => void writeTextToClipboard(link.path, "path")}>
              <CopyIcon className="size-3.5" />
              Copy path
            </MenuItem>
            <MenuItem onClick={onUnlink}>
              <PullRequestGlyph.unlink className="size-3.5" />
              Unlink from thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}
