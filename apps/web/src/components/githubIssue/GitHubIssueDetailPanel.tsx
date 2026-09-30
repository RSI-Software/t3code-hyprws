import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  GitHubIssueDetail,
  GitHubIssueRef,
  GitHubSubIssue,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE } from "@t3tools/contracts/settings";
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  ShapesIcon,
  TagIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type DraftId,
} from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
} from "../pullRequest/PullRequestListRow";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { PullRequestActorLabel, PullRequestMetaLine } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { toastManager } from "../ui/toast";
import { GitHubIssueActionsMenu } from "./GitHubIssueActionsMenu";
import { GitHubIssueLabelChip, GitHubIssueTypeChip } from "./GitHubIssueChips";
import { GitHubIssueEmptyState } from "./GitHubIssueEmptyState";
import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";
import { GitHubIssueStateGlyph } from "./githubIssuePresentation";

export function githubIssueHandoffPrompt(
  issue: Pick<GitHubIssueDetail, "number" | "title" | "url">,
  template = DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE,
): string {
  return template
    .replaceAll("{{number}}", String(issue.number))
    .replaceAll("{{title}}", issue.title)
    .replaceAll("{{url}}", issue.url);
}

type IssueDraftStore = Pick<
  ReturnType<typeof useComposerDraftStore.getState>,
  "getComposerDraft" | "setPrompt"
>;

export function seedGitHubIssueDraftIfEmpty(
  draftId: DraftId,
  prompt: string,
  store: IssueDraftStore = useComposerDraftStore.getState(),
): boolean {
  if (composerDraftHasUserContent(store.getComposerDraft(draftId))) return false;
  store.setPrompt(draftId, prompt);
  return true;
}

export function GitHubIssueDetailPanel({
  environmentId,
  composerTarget,
  onSelectSubIssue,
  reference,
}: {
  readonly environmentId: EnvironmentId;
  readonly composerTarget: ScopedThreadRef | null;
  readonly onSelectSubIssue: (child: GitHubSubIssue) => void;
  readonly reference: GitHubIssueRef;
}) {
  const query = useEnvironmentQuery(
    githubIssueEnvironment.detail({ environmentId, input: reference }),
  );
  // The detail query is shared with the issues page and keeps its answer while idle, so an
  // already-read issue would otherwise show the cached read. Every arrival at an issue is worth
  // one re-read, whether the panel just mounted or the reference changed underneath it:
  // everything after that is the reader's explicit refresh. The server answers detail straight
  // from the host with no cache of its own, so a re-read is the refresh. Keyed on the issue
  // identity rather than the mount, and read through a ref so a new `refresh` closure alone
  // never spends another read.
  const issueKey = `${environmentId}:${reference.projectId}:${reference.repository.toLowerCase()}#${reference.number}`;
  const refreshOnOpen = useRef(query.refresh);
  refreshOnOpen.current = query.refresh;
  useEffect(() => {
    refreshOnOpen.current();
  }, [issueKey]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <EnvironmentGitHubIssueDetailContent
        environmentId={environmentId}
        composerTarget={composerTarget}
        detail={query.data}
        error={query.error}
        loading={query.isPending}
        refreshing={query.isPending}
        onRefresh={query.refresh}
        onRetry={query.refresh}
        onSelectSubIssue={onSelectSubIssue}
      />
    </div>
  );
}

export function EnvironmentGitHubIssueDetailContent({
  environmentId,
  ...props
}: Omit<Parameters<typeof GitHubIssueDetailContent>[0], "environmentId"> & {
  readonly environmentId: EnvironmentId;
}) {
  const handoffPromptTemplate = useEnvironmentSettings(
    environmentId,
    (settings) => settings.githubIssueHandoffPromptTemplate,
  );
  return (
    <GitHubIssueDetailContent
      {...props}
      environmentId={environmentId}
      handoffPromptTemplate={handoffPromptTemplate}
    />
  );
}

export function GitHubIssueDetailContent({
  environmentId,
  composerTarget = null,
  copyLinkShortcut = false,
  detail,
  error,
  handoffPromptTemplate = DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE,
  loading,
  refreshing = false,
  onRefresh,
  onRetry,
  onSelectSubIssue,
}: {
  readonly environmentId: EnvironmentId | null;
  /** The thread the panel sits beside, whose composer takes the issue's questions. */
  readonly composerTarget?: ScopedThreadRef | null;
  /** Whether the page's copy-link shortcut copies this issue, so the menu may show it. */
  readonly copyLinkShortcut?: boolean;
  readonly detail: GitHubIssueDetail | null;
  readonly error: string | null;
  readonly handoffPromptTemplate?: string;
  readonly loading: boolean;
  /** True while the header refresh is running: the glyph holds the panel's place until it answers. */
  readonly refreshing?: boolean;
  /** Re-reads the issue on demand. Absent where the panel owns no read, like the empty state. */
  readonly onRefresh?: () => void;
  readonly onRetry: () => void;
  /** Opens a same-repository child in the surface that owns this detail view. */
  readonly onSelectSubIssue?: (child: GitHubSubIssue) => void;
}) {
  const newThread = useNewThreadHandler();
  const [preparing, setPreparing] = useState(false);

  const workOnIssue = async () => {
    if (!detail || !environmentId || preparing) return;
    setPreparing(true);
    try {
      const opened = await newThread(scopeProjectRef(environmentId, detail.projectId));
      if (opened === null) throw new Error("Draft creation returned no destination.");
      const seeded = seedGitHubIssueDraftIfEmpty(
        opened.draftId,
        githubIssueHandoffPrompt(detail, handoffPromptTemplate),
      );
      toastManager.add({
        type: "success",
        title: seeded ? "Issue ready in a thread" : "Thread opened",
        description: seeded
          ? "The task is in the composer — read it over, then send."
          : "The existing composer was left unchanged.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "The issue is still open. Try again from its project.",
      });
    } finally {
      setPreparing(false);
    }
  };

  if (loading && detail === null) return <GitHubIssueDetailGhost />;
  if (error && detail === null) {
    return (
      <GitHubIssueEmptyState
        title="Could not load this issue"
        description={error}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }
  if (detail === null) {
    return (
      <GitHubIssueEmptyState
        title="Select an issue"
        description="Open an issue to read its description and discussion, then hand it to an agent."
      />
    );
  }
  if (environmentId === null) {
    return (
      <GitHubIssueEmptyState
        title="GitHub issues unavailable"
        description="This issue's environment is no longer available."
      />
    );
  }

  // An environment on an older server omits the key rather than sending an empty list.
  const subIssues = detail.subIssues ?? [];
  const closedSubIssues = subIssues.filter((child) => child.state === "closed").length;

  return (
    <article className="min-w-0">
      <header className="min-w-0 px-4 pt-3 pb-4">
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <GitHubIssueStateGlyph state={detail.state} />
          <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{detail.number}</span>
          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground/70">
            {detail.repository}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <GitHubIssueActionsMenu
              environmentId={environmentId}
              detail={detail}
              composerTarget={composerTarget}
              refreshing={refreshing}
              onRefresh={onRefresh}
              copyLinkShortcut={copyLinkShortcut}
            />
            <Button size="xs" onClick={() => void workOnIssue()} disabled={preparing}>
              <WrenchIcon className="size-3" />
              {preparing ? "Preparing..." : "Work on this issue"}
            </Button>
          </div>
        </div>
        <h1 className="mt-1 text-balance font-semibold text-base leading-snug">{detail.title}</h1>
        <div className="mt-2 flex min-h-5 min-w-0 items-center text-xs text-muted-foreground">
          <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
            <PullRequestActorLabel
              key="author"
              actor={detail.author}
              profileUrl={gitHubProfileUrl(detail.author?.login, detail.url)}
            />
            <span key="opened">opened {formatRelativeTimeLabel(detail.createdAt)}</span>
            {detail.closedAt ? (
              <span key="closed">closed {formatRelativeTimeLabel(detail.closedAt)}</span>
            ) : (
              <span key="updated">updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
            )}
          </PullRequestMetaLine>
        </div>
      </header>

      <section aria-label="Issue facts" className="space-y-2 px-4 pt-2.5 pb-1">
        {detail.issueType == null ? null : (
          <GitHubIssueMetaRow icon={<ShapesIcon className="size-3.5" />} label="Type">
            <GitHubIssueTypeChip issueType={detail.issueType} size="default" />
          </GitHubIssueMetaRow>
        )}
        <GitHubIssueMetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
          {detail.labels.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {detail.labels.map((label) => (
                <GitHubIssueLabelChip
                  key={label.name}
                  label={label}
                  size="default"
                  className="max-w-48"
                />
              ))}
            </span>
          )}
        </GitHubIssueMetaRow>
        <GitHubIssueMetaRow icon={<UsersIcon className="size-3.5" />} label="Assignees">
          {detail.assignees.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              {detail.assignees.map((assignee) => (
                <PullRequestActorLabel
                  key={assignee.login}
                  actor={assignee}
                  profileUrl={gitHubProfileUrl(assignee.login, detail.url)}
                />
              ))}
            </span>
          )}
        </GitHubIssueMetaRow>
      </section>

      <GitHubIssueSection key={`description:${detail.url}`} title="Description">
        <PullRequestMarkdown
          text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
          cwd={detail.workspaceRoot}
          environmentId={environmentId}
        />
      </GitHubIssueSection>

      {subIssues.length > 0 ? (
        <GitHubIssueSection
          key={`sub-issues:${detail.url}`}
          title="Sub-issues"
          count={`${closedSubIssues} of ${subIssues.length} closed`}
        >
          <ul className="space-y-0.5">
            {subIssues.map((child) => (
              <li key={child.url}>
                <GitHubSubIssueRow
                  child={child}
                  repository={detail.repository}
                  {...(onSelectSubIssue ? { onSelect: onSelectSubIssue } : {})}
                />
              </li>
            ))}
          </ul>
        </GitHubIssueSection>
      ) : null}

      <GitHubIssueSection
        key={`discussion:${detail.url}`}
        title="Discussion"
        count={String(detail.commentCount)}
      >
        <div className="space-y-3">
          {detail.commentCount > detail.comments.length ? (
            <p className="text-muted-foreground text-xs">
              Showing the newest {detail.comments.length} of {detail.commentCount}
            </p>
          ) : null}
          {detail.comments.map((comment) => (
            <article
              key={comment.id}
              // Offscreen comments skip style, layout and paint, as the pull request's do.
              className="rounded-lg border border-border/60 bg-background [contain-intrinsic-block-size:160px] [content-visibility:auto]"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg bg-muted/25 px-3 py-2.5 text-xs">
                <PullRequestActorLabel
                  actor={comment.author}
                  profileUrl={gitHubProfileUrl(comment.author?.login, detail.url)}
                  className="max-w-full"
                />
                <a
                  href={comment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground hover:underline"
                >
                  <time dateTime={comment.createdAt}>
                    {formatRelativeTimeLabel(comment.createdAt)}
                  </time>
                </a>
              </div>
              <PullRequestMarkdown
                className="px-3 py-3"
                text={comment.body}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
              />
            </article>
          ))}
          {detail.comments.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-xs">No comments yet.</p>
          ) : null}
        </div>
      </GitHubIssueSection>
    </article>
  );
}

/** GitHub attributes work from a deleted account to "ghost", which has no profile; nor do bots. */
function gitHubProfileUrl(login: string | undefined, issueUrl: string): string | null {
  if (!login || login.endsWith("[bot]")) return null;
  try {
    return new URL(`/${encodeURIComponent(login)}`, issueUrl).toString();
  } catch {
    return null;
  }
}

/** The pull request summary's fact row: a fixed label column, then the value. */
function GitHubIssueMetaRow({
  icon,
  label,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

/**
 * The pull request summary's section: a heading that rides the top of the scroll box and folds
 * the body away, so a long discussion can be collapsed from wherever it has been read to.
 */
function GitHubIssueSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<section aria-label={title} />}>
      <div className="sticky top-0 z-10 flex w-full items-center bg-background pr-4">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left font-medium text-muted-foreground text-xs hover:text-foreground">
          <span>{title}</span>
          {count ? <span className="tabular-nums text-muted-foreground/60">{count}</span> : null}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel keepMounted>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * A child's repository, read off its URL. GitHub allows a sub-issue in another repository, and the
 * detail request only reaches the one this issue belongs to, so a foreign child opens on GitHub.
 */
const SUB_ISSUE_REPOSITORY = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/;

function gitHubSubIssueRepository(url: string): string | null {
  return SUB_ISSUE_REPOSITORY.exec(url)?.[1] ?? null;
}

export function GitHubSubIssueRow({
  child,
  repository,
  onSelect,
}: {
  readonly child: GitHubSubIssue;
  readonly repository: string;
  readonly onSelect?: (child: GitHubSubIssue) => void;
}) {
  const sameRepository =
    gitHubSubIssueRepository(child.url)?.toLowerCase() === repository.toLowerCase();
  const inner = (
    <>
      <GitHubIssueStateGlyph state={child.state} />
      <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{child.number}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{child.title}</span>
    </>
  );
  const actionClassName = cn(
    PULL_REQUEST_ROW_CLASS,
    "min-w-0 flex-1 px-2 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  );

  if (onSelect === undefined || !sameRepository) {
    return (
      <a href={child.url} target="_blank" rel="noreferrer noopener" className={actionClassName}>
        {inner}
        <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </a>
    );
  }
  return (
    <div className="group/sub-issue flex items-center">
      <button type="button" className={actionClassName} onClick={() => onSelect(child)}>
        {inner}
      </button>
      <Button
        render={<a href={child.url} target="_blank" rel="noreferrer noopener" />}
        size="icon-xs"
        variant="ghost"
        className="shrink-0"
        aria-label={`Open issue #${child.number} on GitHub`}
      >
        <ExternalLinkIcon />
      </Button>
    </div>
  );
}
