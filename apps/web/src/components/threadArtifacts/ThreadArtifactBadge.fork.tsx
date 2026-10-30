import type { ScopedThreadRef, ThreadArtifactLink } from "@t3tools/contracts";
import { useRender } from "@base-ui/react/use-render";
import { fileBasename } from "@t3tools/shared/path";
import { ChevronDown, ChevronUp } from "lucide";
import { FileCodeIcon, FileIcon, FileTextIcon } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import { useState } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "../chat/threadDetailsPanelStyles";
import { LinkedBadgeTooltipPopupFork } from "../LinkedBadgeTooltipPopup.fork";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  openThreadArtifactFork,
  ThreadArtifactsTabIconFork,
  useThreadWorkspaceRootFork,
} from "./threadArtifacts.fork";

const MISSING_CLASS = "text-muted-foreground/60 line-through";

/** A linked file's glyph: HTML, Markdown, or anything else. */
export function ThreadArtifactIconFork({
  path,
  className,
}: {
  readonly path: string;
  readonly className: string;
}) {
  if (/\.html?$/i.test(path)) return <FileCodeIcon aria-hidden className={className} />;
  if (/\.(?:md|mdx|markdown)$/i.test(path)) {
    return <FileTextIcon aria-hidden className={className} />;
  }
  return <FileIcon aria-hidden className={className} />;
}

/**
 * The linked-artifact twin of the thread issue badge: a glyph and the link count, every link on
 * hover. A click opens the thread's Artifacts tab.
 */
export function ThreadArtifactBadgeFork({
  render,
  artifacts,
  onOpenList,
}: {
  readonly render: ReactElement<{ render?: useRender.RenderProp }>;
  readonly artifacts: ReadonlyArray<ThreadArtifactLink> | undefined;
  readonly onOpenList: () => void;
}) {
  const links = artifacts ?? [];
  const control = useRender({
    render,
    props: {
      render: <button type="button" />,
      "aria-label": `${links.length} linked artifact${links.length === 1 ? "" : "s"}`,
      onPointerDown: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
      onClick: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenList();
      },
    },
  });
  if (links.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={control}>
        <span className="contents font-normal text-xs tabular-nums text-muted-foreground">
          <ThreadArtifactsTabIconFork aria-hidden className="size-3 shrink-0" />
          <span className="text-secondary-label">{links.length}</span>
        </span>
      </TooltipTrigger>
      <LinkedBadgeTooltipPopupFork>
        <ThreadArtifactsMiniListFork artifacts={links} />
      </LinkedBadgeTooltipPopupFork>
    </Tooltip>
  );
}

function ThreadArtifactsMiniListFork({
  artifacts,
}: {
  readonly artifacts: ReadonlyArray<ThreadArtifactLink>;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {artifacts.map((link) => {
        return (
          <li key={link.path} className="flex min-w-0 items-center gap-2">
            <ThreadArtifactIconFork
              path={link.path}
              className="size-3 shrink-0 text-muted-foreground"
            />
            <span
              className={cn("min-w-0 truncate text-foreground/75", link.missing && MISSING_CLASS)}
            >
              {link.title}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
              {link.missing ? "missing" : <RelativeTime timestamp={link.updatedAt} />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Linked artifacts in the sidebar thread hover card, after its linked issues. */
export function ThreadHoverCardArtifactsFork({
  artifacts,
}: {
  readonly artifacts: ReadonlyArray<ThreadArtifactLink> | undefined;
}) {
  if (!artifacts?.length) return null;
  return (
    <div className="-ml-0.5 mt-0.5 min-w-0 border-t border-border/60 pt-2 pl-0.5">
      <ThreadArtifactsMiniListFork artifacts={artifacts} />
    </div>
  );
}

/**
 * Linked artifacts under the thread-details issue rows: the newest, the rest behind the same
 * Show more toggle. A row opens the file in the right panel.
 */
export function ThreadDetailsArtifactRowsFork({
  threadRef,
  artifacts,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly artifacts: ReadonlyArray<ThreadArtifactLink> | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const workspaceRoot = useThreadWorkspaceRootFork(threadRef);
  const links = (artifacts ?? []).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [lead, ...rest] = links;
  if (lead === undefined) return null;

  const row = (link: ThreadArtifactLink) => {
    return (
      <Tooltip key={link.path}>
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              type="button"
              variant="ghost"
              size="sm"
              part="row"
              aria-label={link.path}
              onClick={() => openThreadArtifactFork(threadRef, link, workspaceRoot)}
            />
          }
        >
          <ThreadArtifactIconFork
            path={link.path}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left",
              THREAD_DETAILS_PANEL_LABEL_CLASS,
              link.missing && MISSING_CLASS,
            )}
          >
            {link.title}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {link.missing ? "Missing · " : ""}
          {fileBasename(link.path)} · <RelativeTime timestamp={link.updatedAt} />
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <>
      {row(lead)}
      {expanded ? (
        // The card's density measurement skips this marker, like the expanded PR list.
        <div data-thread-details-pr-list className="flex flex-col">
          {rest.map(row)}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          part="row"
          tone="muted"
          className="w-full active:scale-100"
        >
          <MorphIcon
            aria-hidden
            className="size-4 shrink-0"
            icon={expanded ? ChevronUp : ChevronDown}
          />
          {expanded ? "Show less" : `Show ${rest.length} more`}
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}
