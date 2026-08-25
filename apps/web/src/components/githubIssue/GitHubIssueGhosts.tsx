import { cn } from "../../lib/utils";

function GhostBar({ className }: { readonly className?: string }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

export function GitHubIssueListGhosts() {
  return (
    <div
      aria-label="Loading issues"
      role="status"
      className="animate-ghost-pulse divide-y divide-border/60"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3">
          <GhostBar className="mt-0.5 size-4 rounded-full" />
          <div>
            <GhostBar className="h-4 w-4/5" />
            <GhostBar className="mt-2 h-3 w-2/5" />
          </div>
          <GhostBar className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

export function GitHubIssueDetailGhost() {
  return (
    <div
      role="status"
      aria-label="Loading issue"
      className="animate-ghost-pulse mx-auto w-full max-w-3xl px-5 py-6 sm:px-8"
    >
      <div className="flex items-start gap-4">
        <GhostBar className="mt-1 size-5 rounded-full" />
        <div className="min-w-0 flex-1">
          <GhostBar className="h-5 w-4/5" />
          <GhostBar className="mt-2 w-3/5" />
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-border/70 p-4">
        <GhostBar className="w-full" />
        <GhostBar className="mt-2 w-11/12" />
        <GhostBar className="mt-2 w-3/4" />
      </div>
      <GhostBar className="mt-8 h-4 w-32" />
    </div>
  );
}
