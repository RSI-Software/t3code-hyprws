import { CircleCheckIcon, ClockIcon } from "lucide-react";

import { useClientSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { formatChatTimestampTooltip } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { formatWorkingDurationLabel } from "./Sidebar.logic";
import {
  formatSidebarRelativeTimeLabel,
  resolveCompletedTurnTiming,
} from "./Sidebar.completedTiming.fork";

/** Minute-ticking age of a Done row's completion, beside its status label. */
export function SidebarCompletedAgeFork(props: { completedAt: string }) {
  useNowMinute();
  return <span className="tabular-nums">{formatSidebarRelativeTimeLabel(props.completedAt)}</span>;
}

/** Hover-card rows for the latest finished run: duration and completion time. */
export function SidebarCompletedTimingTooltipFork(props: {
  thread: Pick<SidebarThreadSummary, "latestRun">;
}) {
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const completedTiming = resolveCompletedTurnTiming(props.thread);
  if (completedTiming === null) return null;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <CircleCheckIcon aria-hidden className="size-3 shrink-0 stroke-success" />
        <div className="min-w-0 truncate text-foreground/75">
          Done in {formatWorkingDurationLabel(completedTiming.durationMs)}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <ClockIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
        <div className="min-w-0 truncate text-foreground/75">
          Completed {formatChatTimestampTooltip(completedTiming.completedAt, timestampFormat)}
        </div>
      </div>
    </>
  );
}
