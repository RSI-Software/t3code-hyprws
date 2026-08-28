import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  GitHubIssueDetail,
  GitHubIssueRef,
  GitHubSubIssue,
} from "@t3tools/contracts";
import { DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE } from "@t3tools/contracts/settings";
import {
  CircleDotIcon,
  CircleSlash2Icon,
  ExternalLinkIcon,
  ListTreeIcon,
  MessageSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

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
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { GitHubIssueLabelChip, GitHubIssueTypeChip } from "./GitHubIssueChips";
import { GitHubIssueEmptyState } from "./GitHubIssueEmptyState";
import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";

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
  onSelectSubIssue,
  reference,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSelectSubIssue: (child: GitHubSubIssue) => void;
  readonly reference: GitHubIssueRef;
}) {
  const query = useEnvironmentQuery(
    githubIssueEnvironment.detail({ environmentId, input: reference }),
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <EnvironmentGitHubIssueDetailContent
        environmentId={environmentId}
        detail={query.data}
        error={query.error}
        loading={query.isPending}
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
  detail,
  error,
  handoffPromptTemplate = DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE,
  loading,
  onRetry,
  onSelectSubIssue,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly detail: GitHubIssueDetail | null;
  readonly error: string | null;
  readonly handoffPromptTemplate?: string;
  readonly loading: boolean;
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

  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <GitHubIssueStateIcon
            state={detail.state}
            className={cn(
              "mt-1 size-5 shrink-0",
              detail.state === "open" ? "text-success-foreground" : "text-muted-foreground",
            )}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-balance font-semibold text-xl leading-tight">{detail.title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {detail.repository} #{detail.number} · opened by {detail.author?.login ?? "unknown"} ·{" "}
              {formatRelativeTimeLabel(detail.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void workOnIssue()} disabled={preparing}>
            <WrenchIcon className="size-4" />
            {preparing ? "Preparing..." : "Work on this issue"}
          </Button>
          <Button
            render={<a href={detail.url} target="_blank" rel="noreferrer noopener" />}
            size="icon-sm"
            variant="outline"
            aria-label="Open issue on GitHub"
          >
            <ExternalLinkIcon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-1.5 text-xs">
        {detail.issueType == null ? null : (
          <GitHubIssueTypeChip issueType={detail.issueType} className="px-2" />
        )}
        {detail.labels.map((label) => (
          <GitHubIssueLabelChip key={label.name} label={label} className="px-2" />
        ))}
        {detail.assignees.map((assignee) => (
          <span
            key={assignee.login}
            className="rounded-full border border-border px-2 py-0.5 text-muted-foreground text-xs"
          >
            assigned to {assignee.login}
          </span>
        ))}
      </div>

      <section className="mt-6 rounded-xl border border-border/70 bg-card/30 p-4">
        {detail.body ? (
          <PullRequestMarkdown
            text={detail.body}
            cwd={detail.workspaceRoot}
            environmentId={environmentId}
          />
        ) : (
          <p className="text-muted-foreground text-sm">No description provided.</p>
        )}
      </section>

      {subIssues.length > 0 ? (
        <section className="mt-6">
          <h3 className="flex items-center gap-2 font-medium text-sm">
            <ListTreeIcon className="size-4" /> Sub-issues (
            {subIssues.filter((child) => child.state === "closed").length} of {subIssues.length}{" "}
            closed)
          </h3>
          <ul className="mt-3 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
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
        </section>
      ) : null}

      <section className="mt-8">
        <h3 className="flex items-center gap-2 font-medium text-sm">
          <MessageSquareIcon className="size-4" /> Discussion ({detail.commentCount})
        </h3>
        <div className="mt-3 space-y-3">
          {detail.commentCount > detail.comments.length ? (
            <p className="text-muted-foreground text-xs">
              Showing newest {detail.comments.length} of {detail.commentCount}
            </p>
          ) : null}
          {detail.comments.map((comment) => (
            <div
              key={comment.id}
              className="rounded-xl border border-border/70 p-4 [contain-intrinsic-block-size:140px] [content-visibility:auto]"
            >
              <p className="mb-3 text-muted-foreground text-xs">
                {comment.author?.login ?? "unknown"} commented{" "}
                {formatRelativeTimeLabel(comment.createdAt)}
              </p>
              <PullRequestMarkdown
                text={comment.body}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
              />
            </div>
          ))}
          {detail.comments.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">No comments yet.</p>
          ) : null}
        </div>
      </section>
    </article>
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
      <GitHubIssueStateIcon
        state={child.state}
        className={cn(
          "size-4 shrink-0",
          child.state === "open" ? "text-success-foreground" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{child.title}</span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">#{child.number}</span>
    </>
  );
  const actionClassName =
    "flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  if (onSelect === undefined || !sameRepository) {
    return (
      <a
        href={child.url}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(actionClassName, "w-full")}
      >
        {inner}
        <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </a>
    );
  }
  return (
    <div className="flex items-center">
      <button type="button" className={actionClassName} onClick={() => onSelect(child)}>
        {inner}
      </button>
      <Button
        render={<a href={child.url} target="_blank" rel="noreferrer noopener" />}
        size="icon-sm"
        variant="ghost"
        className="mr-1 shrink-0 text-muted-foreground"
        aria-label={`Open issue #${child.number} on GitHub`}
      >
        <ExternalLinkIcon className="size-3.5" />
      </Button>
    </div>
  );
}

export function GitHubIssueStateIcon({
  state,
  className,
}: {
  readonly state: GitHubIssueDetail["state"];
  readonly className?: string;
}) {
  const Icon = state === "open" ? CircleDotIcon : CircleSlash2Icon;
  const label = state === "open" ? "Open issue" : "Closed issue";
  return <Icon role="img" aria-label={label} className={className} />;
}
