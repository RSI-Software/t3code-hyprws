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

/** The detail's own shape: title, meta line, facts, then the description section. */
export function GitHubIssueDetailGhost() {
  return (
    <div role="status" aria-label="Loading issue" className="motion-safe:animate-skeleton">
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className="w-40" />
          <div className="ml-auto flex gap-1.5">
            <GhostBar className="h-7 w-32 rounded-md" />
            <GhostBar className="size-7 rounded-md" />
          </div>
        </div>
        <GhostBar className="mt-3 h-5 w-4/5" />
        <GhostBar className="mt-2.5 w-2/5" />
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
