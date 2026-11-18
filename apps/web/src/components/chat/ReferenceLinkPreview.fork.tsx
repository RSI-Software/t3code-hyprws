import { useMessages } from "gt-react";
import type { ReactElement } from "react";

import { RelativeTime } from "~/components/RelativeTime";

import { issueStatePresentation } from "../issue/issuePresentation";
import {
  PullRequestActorAvatar,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import type { ReferenceSummaryFork } from "./referenceSummary.fork";

/** A reference's state icon, tone, and label, as upstream's issue and pull request views show it. */
export function useReferenceStateFork(summary: ReferenceSummaryFork | null) {
  const messages = useMessages();
  if (summary === null) return null;
  return summary.state.kind === "issue"
    ? issueStatePresentation(summary.state.state)
    : resolvePullRequestState(summary.state, messages);
}

/** Fork: an issue link's hover card, laid out like upstream's `PullRequestLinkPreview`. */
export function ReferenceLinkPreview({
  trigger,
  summary,
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  summary: ReferenceSummaryFork | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const state = useReferenceStateFork(summary);
  const author = summary?.author;
  const authorLabel =
    author?.name && author.name !== author.login
      ? `${author.name} (@${author.login})`
      : (author?.login ?? null);
  return (
    <PreviewCard open={open} onOpenChange={onOpenChange}>
      <PreviewCardTrigger render={trigger} delay={350} closeDelay={120} />
      {summary === null ? null : (
        <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)]">
          <div className="min-w-0 p-3">
            <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
              {summary.displayKey.startsWith(summary.scope) ? null : (
                <span className="min-w-0 truncate">{summary.scope}</span>
              )}
              <span className="shrink-0">{summary.displayKey}</span>
              <span aria-hidden>·</span>
              {state === null ? null : (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
                  {state.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
              {summary.title}
            </p>
            {author === null || author === undefined ? null : (
              <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <PullRequestActorAvatar actor={author} className="size-4" />
                <span className="min-w-0 truncate">{authorLabel}</span>
                {summary.createdAt === null ? null : (
                  <>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">
                      opened <RelativeTime timestamp={summary.createdAt} />
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </PreviewCardPopup>
      )}
    </PreviewCard>
  );
}
