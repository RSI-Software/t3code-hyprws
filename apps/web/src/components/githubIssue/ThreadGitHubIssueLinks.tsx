import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { GitHubSubIssue, ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleHelpIcon,
  CornerLeftUpIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GitHubIssueStateGlyph } from "./githubIssuePresentation";
import { openLinkGitHubIssueDialog } from "./LinkGitHubIssueDialog";
import { ThreadIssueSubIssueProgressFork } from "./ThreadIssueBadge.fork";
import {
  subIssueProgress,
  threadIssueTree,
  type ThreadIssueTreeNode,
} from "./threadIssueTree.logic";

const SOURCE_LABELS: Record<ThreadIssueLink["source"], string> = {
  manual: "Linked by you",
  handoff: "Linked when work started",
  agent: "Linked by the agent",
};

const linkKey = (link: ThreadIssueLink) => `${link.host}/${link.repository}#${link.number}`;

function latestSyncedAt(links: ReadonlyArray<ThreadIssueLink>): string | null {
  let latest: string | null = null;
  for (const link of links) {
    const at = link.snapshot?.syncedAt;
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function reportFailure(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const failure = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: failure instanceof Error ? failure.message : undefined,
  });
}

/** The thread's Linked issues panel, laid out like its Linked pull requests panel. */
export function ThreadGitHubIssueLinks({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const supported =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities.threadIssues === true;
  if (!supported) {
    return (
      <PullRequestsUnavailableState
        title="Linked issues unavailable"
        error="This environment does not keep linked issues."
      />
    );
  }
  return <EnabledThreadGitHubIssueLinks threadRef={threadRef} />;
}

function EnabledThreadGitHubIssueLinks({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const unlink = useAtomCommand(githubIssueEnvironment.unlinkFromThread, { reportFailure: false });
  const sync = useAtomCommand(githubIssueEnvironment.syncThreadLinks, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const loaded = thread !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to reread stale GitHub links once per thread per mount; it skips fresh ones.
  useEffect(() => {
    if (!loaded) return;
    void sync({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, scope: "stale" },
    });
  }, [loaded, sync, threadRef.environmentId, threadRef.threadId]);
  const links = thread?.issues ?? [];
  const openCount = links.filter((link) => link.snapshot?.state === "open").length;
  const lastSynced = latestSyncedAt(links);
  const openLinkDialog = () => openLinkGitHubIssueDialog(threadRef);

  const unlinkIssue = async (link: ThreadIssueLink) => {
    const result = await unlink({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      },
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    reportFailure(`Could not unlink issue #${link.number}`, result);
  };

  const refresh = async () => {
    setRefreshing(true);
    const result = await sync({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, scope: "all" },
    });
    setRefreshing(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    reportFailure("Could not refresh linked issues", result);
  };

  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked issues</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Issues this thread works on land here. Link one yourself from a URL or a number.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link issue
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {threadIssueTree(links).map((node) => (
          <IssueLinkTree
            key={linkKey(node.link)}
            node={node}
            root
            threadRef={threadRef}
            onUnlink={(target) => void unlinkIssue(target)}
          />
        ))}
      </div>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {openCount} open · {links.length} linked
          {lastSynced ? (
            <>
              {" · synced "}
              <RelativeTime timestamp={lastSynced} />
            </>
          ) : null}
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh linked issues from GitHub"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button size="xs" variant="ghost" onClick={openLinkDialog}>
            <PlusIcon className="size-3.5" />
            Link
          </Button>
        </span>
      </footer>
    </div>
  );
}

/**
 * A link and the sub-issues GitHub lists under it. Children the thread also links always show,
 * nested; the rest wait behind a toggle so a large tracker does not flood the panel.
 */
function IssueLinkTree({
  node,
  root,
  threadRef,
  onUnlink,
}: {
  readonly node: ThreadIssueTreeNode;
  readonly root: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly onUnlink: (link: ThreadIssueLink) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const unlinked = node.children.filter((entry) => entry.node === null).length;
  const shown = expanded ? node.children : node.children.filter((entry) => entry.node !== null);
  return (
    <>
      <IssueLinkRow link={node.link} root={root} threadRef={threadRef} onUnlink={onUnlink} />
      {node.children.length > 0 ? (
        <div className="ml-4 border-l border-border/60 pl-1">
          {shown.map(({ child, node: linked }) =>
            linked === null ? (
              <SubIssueRow key={child.url} child={child} threadRef={threadRef} />
            ) : (
              <IssueLinkTree
                key={linkKey(linked.link)}
                node={linked}
                root={false}
                threadRef={threadRef}
                onUnlink={onUnlink}
              />
            ),
          )}
          {unlinked > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
              {expanded ? (
                <ChevronUpIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
              {expanded
                ? "Hide sub-issues"
                : `Show ${unlinked} ${shown.length > 0 ? "more " : ""}sub-issue${unlinked === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** A sub-issue the thread does not link: it opens like a link, without link actions. */
function SubIssueRow({
  child,
  threadRef,
}: {
  readonly child: GitHubSubIssue;
  readonly threadRef: ScopedThreadRef;
}) {
  const openLink = useOpenPrLink(threadRef);
  return (
    <a
      href={child.url}
      onClick={(event) => openLink(event, child.url, threadRef)}
      className={cn(PULL_REQUEST_ROW_CLASS, "pl-2 hover:bg-accent/60")}
    >
      <GitHubIssueStateGlyph state={child.state} closeReason={child.closeReason ?? null} />
      <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{child.number}</span>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{child.title}</span>
    </a>
  );
}

function IssueLinkRow({
  link,
  root,
  threadRef,
  onUnlink,
}: {
  readonly link: ThreadIssueLink;
  readonly root: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly onUnlink: (link: ThreadIssueLink) => void;
}) {
  const progress = subIssueProgress(link);
  // A nested link's parent is the row above it.
  const parent = root ? (link.snapshot?.parent ?? null) : null;
  const openLink = useOpenPrLink(threadRef);
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
      <IssueLinkStateGlyph link={link} />
      <a
        href={link.url}
        onClick={(event) => openLink(event, link.url, threadRef)}
        className="flex min-w-0 flex-1"
      >
        <PullRequestRowLines
          number={
            <Tooltip>
              <TooltipTrigger render={<span className={PULL_REQUEST_ROW_NUMBER_CLASS} />}>
                #{link.number}
              </TooltipTrigger>
              <TooltipPopup>
                {SOURCE_LABELS[link.source]} · <RelativeTime timestamp={link.linkedAt} />
              </TooltipPopup>
            </Tooltip>
          }
          title={link.snapshot?.title ?? link.repository}
          status={
            progress === null ? null : (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <ThreadIssueSubIssueProgressFork link={link} />
                </TooltipTrigger>
                <TooltipPopup>
                  {progress.closed} of {progress.total} sub-issues closed
                </TooltipPopup>
              </Tooltip>
            )
          }
          meta={
            <>
              <Tooltip>
                <TooltipTrigger render={<span className="flex min-w-0 max-w-40 font-mono" />}>
                  <MiddleTruncate value={link.repository} showTitle={false} />
                </TooltipTrigger>
                <TooltipPopup>
                  {link.host}/{link.repository}
                </TooltipPopup>
              </Tooltip>
              {parent === null ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="inline-flex min-w-0 shrink items-center gap-0.5" />}
                  >
                    <CornerLeftUpIcon aria-hidden className="size-3 shrink-0" />
                    <span className="truncate">#{parent.number}</span>
                  </TooltipTrigger>
                  <TooltipPopup>
                    Sub-issue of #{parent.number}: {parent.title}
                  </TooltipPopup>
                </Tooltip>
              )}
            </>
          }
        />
      </a>
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden controls would intercept link taps on touch screens.
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
                aria-label={`Actions for #${link.number}`}
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
            <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            <MenuItem onClick={(event) => openLink(event, link.url, threadRef)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open
            </MenuItem>
            <MenuItem onClick={() => onUnlink(link)}>
              <PullRequestGlyph.unlink className="size-3.5" />
              Unlink from thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

/** A link without a successful read says so, rather than passing for an open issue. */
function IssueLinkStateGlyph({ link }: { readonly link: ThreadIssueLink }) {
  if (link.snapshot !== null) {
    return (
      <GitHubIssueStateGlyph
        state={link.snapshot.state}
        closeReason={link.snapshot.closeReason ?? null}
      />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <CircleHelpIcon
          role="img"
          aria-label="State unknown"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </TooltipTrigger>
      <TooltipPopup>State unknown</TooltipPopup>
    </Tooltip>
  );
}
