import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  githubIssueLinkTarget,
  type EnvironmentId,
  type GitHubIssueDetail,
  type GitHubIssueRef,
  type GitHubSubIssue,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE } from "@t3tools/contracts/settings";
import {
  ExternalLinkIcon,
  LinkIcon,
  ShapesIcon,
  TagIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

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
import { RelativeTime } from "../RelativeTime";
import { PullRequestDetailCrumbs } from "../pullRequest/PullRequestDetailCrumbs";
import { CrumbsSubjectForkProvider } from "../pullRequest/PullRequestDetailCrumbs.fork";
import { PullRequestDetailTitleRow } from "../pullRequest/PullRequestDetailLayout";
import { openOnHostLabel } from "../pullRequest/pullRequestLinkContextMenu";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
} from "../pullRequest/PullRequestListRow";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { MetaRow, Section } from "../pullRequest/PullRequestSummaryTab";
import { PullRequestActorLabel, PullRequestMetaLine } from "../pullRequest/pullRequestPresentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { GitHubIssueActionsMenu } from "./GitHubIssueActionsMenu";
import { GitHubIssueLabelChip, GitHubIssueTypeChip } from "./GitHubIssueChips";
import { GitHubIssueEmptyState } from "./GitHubIssueEmptyState";
import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";
import { GitHubIssueStateGlyph, githubIssueStatePresentation } from "./githubIssuePresentation";
import { githubIssueHandoffs } from "./githubIssueHandoff";
import {
  GitHubIssueLinkedThreadList,
  GitHubIssueThreadPicker,
  useGitHubIssueThreadLinks,
} from "./GitHubIssueThreadLinks";

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
  onBack,
  onSelectSubIssue,
  reference,
}: {
  readonly environmentId: EnvironmentId;
  readonly composerTarget: ScopedThreadRef | null;
  readonly onBack?: (() => void) | undefined;
  readonly onSelectSubIssue: (child: GitHubSubIssue) => void;
  readonly reference: GitHubIssueRef;
}) {
  const query = useEnvironmentQuery(
    githubIssueEnvironment.detail({ environmentId, input: reference }),
  );
  // The detail query is shared with the issues page and keeps its answer while idle, so each
  // arrival at an issue spends one re-read; later ones are the reader's explicit refresh. Keyed
  // on issue identity, and read through an effect event so a new `refresh` closure alone never
  // spends another read.
  const issueKey = `${environmentId}:${reference.projectId}:${reference.repository.toLowerCase()}#${reference.number}`;
  const refreshOnOpen = useEffectEvent(() => query.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server, which reads GitHub uncached, to refresh the shared detail query once per opened issue.
  useEffect(() => {
    refreshOnOpen();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A different issue spends its one open-time re-read.
    issueKey,
  ]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EnvironmentGitHubIssueDetailContent
        environmentId={environmentId}
        composerTarget={composerTarget}
        onBack={onBack}
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
      // Per issue, as upstream keys the pull request detail: another issue opens unfolded.
      key={props.detail?.url}
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
  onBack,
  onRefresh,
  onStateChanged,
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
  /** Returns to the issue list the detail was opened from, as the pull request crumbs do. */
  readonly onBack?: (() => void) | undefined;
  /** Re-reads the issue on demand. Absent where the panel owns no read, like the empty state. */
  readonly onRefresh?: () => void;
  /** Called once the issue has closed or reopened, for a list beside the panel to re-read. */
  readonly onStateChanged?: () => void;
  readonly onRetry: () => void;
  /** Opens a same-repository child in the surface that owns this detail view. */
  readonly onSelectSubIssue?: (child: GitHubSubIssue) => void;
}) {
  const newThread = useNewThreadHandler();
  const [preparing, setPreparing] = useState(false);
  const threadLinks = useGitHubIssueThreadLinks(environmentId, detail);
  const [pickingThread, setPickingThread] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  // Saved before the fold collapses: the browser may clamp scrollTop as the viewport grows.
  const compensationRef = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the scroller's scrollTop before paint after the header condenses
  useLayoutEffect(() => {
    const target = compensationRef.current;
    compensationRef.current = null;
    if (target === null || !condensed || scrollerRef.current === null) return;
    scrollerRef.current.scrollTop = Math.max(0, target);
  }, [condensed]);

  const workOnIssue = async () => {
    if (!detail || !environmentId || preparing) return;
    setPreparing(true);
    const opened = await newThread(scopeProjectRef(environmentId, detail.projectId)).catch(
      () => null,
    );
    setPreparing(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "The issue is still open. Try again from its project.",
      });
      return;
    }
    const seeded = seedGitHubIssueDraftIfEmpty(
      opened.draftId,
      githubIssueHandoffPrompt(detail, handoffPromptTemplate),
    );
    // The issue rides the draft it was handed to and links at that draft's first send. A draft
    // left unchanged still holds whatever it was opened for, so it gains no issue here.
    const handoff = githubIssueLinkTarget(detail.url);
    if (seeded && handoff !== null) githubIssueHandoffs.record(opened.draftId, handoff);
    toastManager.add({
      type: "success",
      title: seeded ? "Issue ready in a thread" : "Thread opened",
      description: seeded
        ? "The task is in the composer. Read it over, then send."
        : "The existing composer was left unchanged.",
    });
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
  const authorProfileUrl = gitHubProfileUrl(detail.author?.login, detail.url);
  const workLabel = preparing ? "Preparing..." : "Work on this issue";
  const statePresentation = githubIssueStatePresentation(detail.state, detail.closeReason);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
      {/* The pull request detail header: crumbs and actions, then a fold that swaps for one
          compact row once the reader scrolls the title away. */}
      <div className="@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        <CrumbsSubjectForkProvider value={ISSUE_SUBJECT}>
          <PullRequestDetailCrumbs
            detail={{ ...detail, provider: "github" }}
            toneClassName={statePresentation.toneClassName}
            condensed={condensed}
            repositoryUrl={gitHubRepositoryUrl(detail.url)}
            openOnHostText={openOnHostLabel(sourceControlClients.get("github"))}
            onBack={onBack}
          />
        </CrumbsSubjectForkProvider>
        <div className="mr-4 flex h-7 shrink-0 select-none items-center justify-end gap-1">
          <TooltipProvider delay={150} closeDelay={150} timeout={400}>
            {detail.state === "open" ? (
              <span className="sr-only">{statePresentation.label}</span>
            ) : (
              <Badge size="control" variant="outline">
                <span className={cn("flex items-center gap-1", statePresentation.toneClassName)}>
                  <statePresentation.Icon aria-hidden className="size-3.5" />
                  {statePresentation.label}
                </span>
              </Badge>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex shrink-0">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={preparing}
                      onClick={() => void workOnIssue()}
                      aria-label={workLabel}
                    >
                      <WrenchIcon aria-hidden className="size-3.5" />
                      <span className="@max-[30rem]/pr-header:hidden">{workLabel}</span>
                    </Button>
                  </span>
                }
              />
              <TooltipPopup side="top">{workLabel}</TooltipPopup>
            </Tooltip>
            <GitHubIssueActionsMenu
              environmentId={environmentId}
              detail={detail}
              composerTarget={composerTarget}
              refreshing={refreshing}
              onRefresh={onRefresh}
              onStateChanged={onStateChanged}
              copyLinkShortcut={copyLinkShortcut}
              threadLinks={threadLinks}
              onPickThread={() => setPickingThread(true)}
            />
          </TooltipProvider>
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[1fr]"
              : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "translate-y-0 opacity-100 delay-50"
                : "translate-y-1 opacity-0 duration-100",
            )}
            inert={!condensed}
          >
            <div className="min-w-0 px-4 pt-1 pb-2">
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
                <PullRequestActorLabel
                  actor={detail.author}
                  profileUrl={authorProfileUrl}
                  variant="avatar"
                  className="shrink-0"
                />
                <span className="shrink-0">
                  <RelativeTime timestamp={detail.updatedAt} />
                </span>
              </span>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={foldRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "-translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50",
            )}
            inert={condensed}
          >
            <div className="mt-1 min-w-0 px-4 pb-4">
              <PullRequestDetailTitleRow>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <h1 className="min-w-0 flex-1 truncate text-base font-semibold leading-snug">
                        {detail.title}
                      </h1>
                    }
                  />
                  <TooltipPopup side="top">{detail.title}</TooltipPopup>
                </Tooltip>
              </PullRequestDetailTitleRow>
              <div className="mt-2 flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <PullRequestMetaLine className="min-w-0 whitespace-nowrap">
                  <PullRequestActorLabel
                    key="author"
                    actor={detail.author}
                    profileUrl={authorProfileUrl}
                  />
                  <span key="opened">
                    opened <RelativeTime timestamp={detail.createdAt} />
                  </span>
                  {detail.closedAt ? (
                    <span key="closed">
                      closed <RelativeTime timestamp={detail.closedAt} />
                    </span>
                  ) : (
                    <span key="updated">
                      updated <RelativeTime timestamp={detail.updatedAt} />
                    </span>
                  )}
                </PullRequestMetaLine>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-pull-request-summary-scroll
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const top = scroller.scrollTop;
          const foldHeight = foldRef.current?.scrollHeight ?? 0;
          if (condensed) {
            if (top < 4 && foldHeight > 0) setCondensed(false);
          } else if (foldHeight > 0 && top > foldHeight + 32) {
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            compensationRef.current = top - chromeDelta;
            setCondensed(true);
          }
        }}
      >
        <section aria-label="Issue facts" className="space-y-2 px-4 pt-2.5 pb-1">
          {detail.issueType == null ? null : (
            <MetaRow icon={<ShapesIcon className="size-3.5" />} label="Type">
              <GitHubIssueTypeChip issueType={detail.issueType} size="default" />
            </MetaRow>
          )}
          <MetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
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
          </MetaRow>
          <MetaRow icon={<UsersIcon className="size-3.5" />} label="Assignees">
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
          </MetaRow>
        </section>

        <Section key={`description:${detail.url}`} title="Description" keepMounted>
          <PullRequestMarkdown
            text={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
            cwd={detail.workspaceRoot}
            environmentId={environmentId}
          />
        </Section>

        {detail.parent ? (
          <Section key={`parent:${detail.url}`} title="Parent">
            <GitHubSubIssueRow
              child={detail.parent}
              repository={gitHubSubIssueRepository(detail.parent.url) ?? detail.repository}
              {...(onSelectSubIssue ? { onSelect: onSelectSubIssue } : {})}
            />
          </Section>
        ) : null}

        {subIssues.length > 0 ? (
          <Section
            key={`sub-issues:${detail.url}`}
            title={`Sub-issues (${closedSubIssues} of ${subIssues.length} closed)`}
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
          </Section>
        ) : null}

        {threadLinks.supported ? (
          <Section
            key={`threads:${detail.url}`}
            title={
              threadLinks.threads === null
                ? "Linked threads"
                : `Linked threads (${threadLinks.threads.length})`
            }
          >
            <GitHubIssueLinkedThreadList links={threadLinks} environmentId={environmentId} />
            <Button
              size="xs"
              variant="ghost"
              className="mt-1"
              disabled={threadLinks.pending}
              onClick={() => setPickingThread(true)}
            >
              <LinkIcon className="size-3" />
              Link to a thread
            </Button>
          </Section>
        ) : null}
        {pickingThread && threadLinks.supported ? (
          <GitHubIssueThreadPicker
            links={threadLinks}
            environmentId={environmentId}
            onOpenChange={setPickingThread}
          />
        ) : null}

        <Section key={`comments:${detail.url}`} title={`Comments (${detail.commentCount})`}>
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
                      <RelativeTime timestamp={comment.createdAt} />
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
              <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
            ) : null}
          </div>
        </Section>
      </div>
    </div>
  );
}

const ISSUE_SUBJECT = { singular: "issue", plural: "issues" } as const;

const ISSUE_REPOSITORY_URL = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/issues\/\d+/;

function gitHubRepositoryUrl(issueUrl: string): string | null {
  return ISSUE_REPOSITORY_URL.exec(issueUrl)?.[1] ?? null;
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

/**
 * A child's repository, read off its URL. GitHub allows a sub-issue in another repository, and the
 * detail request only reaches the one this issue belongs to, so a foreign child opens on GitHub.
 */
const SUB_ISSUE_REPOSITORY = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/;

export function gitHubSubIssueRepository(url: string): string | null {
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
      <GitHubIssueStateGlyph state={child.state} closeReason={child.closeReason ?? null} />
      <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{child.number}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{child.title}</span>
    </>
  );
  const actionClassName = cn(
    PULL_REQUEST_ROW_CLASS,
    "min-w-0 flex-1 px-2 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
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
