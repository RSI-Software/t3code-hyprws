import { cn } from "../../lib/utils";
import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";

function GhostBar({ className }: { readonly className?: string }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

/** Names what is on its way, for the ghost and for held rows alike. */
export function searchingCaption(query?: string): string {
  return query
    ? `Searching GitHub for “${query.length > 48 ? `${query.slice(0, 48)}…` : query}”`
    : "Reading issues from GitHub";
}

/** Names the rows a failed refresh left behind: readable, but not what GitHub says right now. */
export const staleRefreshCaption = "Couldn't refresh · showing last results";

/** The pull request list's ghost, named for what is actually on its way. */
export function GitHubIssueListGhosts({ query }: { readonly query?: string }) {
  return <PullRequestListGhost rows={7} caption={searchingCaption(query)} />;
}

/** The detail's own shape: the pull request header's crumbs, actions and fold, then the facts. */
export function GitHubIssueDetailGhost() {
  return (
    <div
      role="status"
      aria-label="Loading issue"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background motion-safe:animate-skeleton"
    >
      <div className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        <div className="flex h-7 min-w-0 items-center gap-1 pl-4">
          <GhostBar className="w-24" />
          <GhostBar className="w-8" />
        </div>
        <div className="mr-4 flex h-7 shrink-0 items-center justify-end gap-1">
          <GhostBar className="h-6 w-32 rounded-md" />
          <GhostBar className="size-6 rounded-md" />
        </div>
        <div className="col-span-2 mt-1 min-w-0 px-4 pb-4">
          <div className="flex min-h-7 items-center sm:min-h-6">
            <GhostBar className="h-5 w-4/5 max-w-md" />
          </div>
          <div className="mt-2 flex min-h-5 items-center gap-1.5">
            <GhostBar className="size-4 rounded-full" />
            <GhostBar className="w-40" />
          </div>
        </div>
      </div>
      <div className="space-y-2.5 px-4 pt-2.5 pb-1">
        <GhostBar className="w-1/2" />
        <GhostBar className="w-1/3" />
      </div>
      <div className="px-4 py-3">
        <GhostBar className="w-20" />
        <GhostBar className="mt-4 w-full" />
        <GhostBar className="mt-2 w-11/12" />
        <GhostBar className="mt-2 w-3/4" />
      </div>
    </div>
  );
}
