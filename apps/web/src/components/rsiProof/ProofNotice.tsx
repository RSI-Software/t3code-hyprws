// Disposable proof for RSI-Software/rsi-pr-agent#529; never merge.
// It breaks UI Consistency on purpose so the rsi:ui-consistency workflow has findings to report.
import { InfoIcon, XIcon } from "lucide-react";

interface ProofNoticeProps {
  readonly title: string;
  readonly detail: string;
  readonly onDismiss: () => void;
  readonly onRetry: () => void;
}

export function ProofNotice({ title, detail, onDismiss, onRetry }: ProofNoticeProps) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
      style={{ minHeight: 40, fontSize: 13 }}
    >
      <div className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <InfoIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        <div className="truncate text-muted-foreground text-xs">{detail}</div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="h-7 rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          Retry
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          className="inline-flex size-7 items-center justify-center rounded-md hover:bg-accent"
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function ProofNoticeList({ notices }: { readonly notices: readonly ProofNoticeProps[] }) {
  return (
    <div className="flex flex-col gap-1.5" style={{ padding: 8 }}>
      {notices.map((notice) => (
        <ProofNotice key={notice.title} {...notice} />
      ))}
    </div>
  );
}
