import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, GitHubIssueDetail, GitHubIssueRef } from "@t3tools/contracts";
import {
  CircleDotIcon,
  CircleSlash2Icon,
  ExternalLinkIcon,
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
import { cn } from "../../lib/utils";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { PullRequestMarkdown } from "../pullRequest/PullRequestMarkdown";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { GitHubIssueEmptyState } from "./GitHubIssueEmptyState";
import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";

export function githubIssueHandoffPrompt(
  issue: Pick<GitHubIssueDetail, "number" | "title" | "url">,
): string {
  return [
    `Work on GitHub issue #${issue.number}: ${issue.title}`,
    issue.url,
    "Read the issue and make the smallest complete fix, then run focused verification.",
  ].join("\n");
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
  reference,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: GitHubIssueRef;
}) {
  const query = useEnvironmentQuery(
    githubIssueEnvironment.detail({ environmentId, input: reference }),
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <GitHubIssueDetailContent
        environmentId={environmentId}
        detail={query.data}
        error={query.error}
        loading={query.isPending}
        onRetry={query.refresh}
      />
    </div>
  );
}

export function GitHubIssueDetailContent({
  environmentId,
  detail,
  error,
  loading,
  onRetry,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly detail: GitHubIssueDetail | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly onRetry: () => void;
}) {
  const newThread = useNewThreadHandler();
  const [preparing, setPreparing] = useState(false);

  const workOnIssue = async () => {
    if (!detail || !environmentId || preparing) return;
    setPreparing(true);
    try {
      const opened = await newThread(scopeProjectRef(environmentId, detail.projectId));
      if (opened === null) throw new Error("Draft creation returned no destination.");
      const seeded = seedGitHubIssueDraftIfEmpty(opened.draftId, githubIssueHandoffPrompt(detail));
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

      <div className="mt-5 flex flex-wrap gap-1.5">
        {detail.labels.map((label) => (
          <span
            key={label.name}
            className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
          >
            {label.name}
          </span>
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
