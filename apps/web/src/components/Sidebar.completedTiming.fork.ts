// Sidebar Done status and completed-run timing (fork upstream-fixes).
// Upstream shows Done only while a completion is unread; the fork keeps it
// after the thread is read and adds the run's frozen duration to the row and
// its hover card.

import type { SidebarThreadSummary } from "../types";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadStatus } from "./Sidebar.logic";

function firstValidTimestamp(...candidates: ReadonlyArray<string | null>): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && !Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

export interface CompletedTurnTiming {
  readonly completedAt: string;
  readonly durationMs: number;
}

/** Frozen timing for the latest finished run. A missing, malformed, or
    reversed interval is not repaired into a plausible-looking duration. */
export function resolveCompletedTurnTiming(
  thread: Pick<SidebarThreadSummary, "latestRun">,
): CompletedTurnTiming | null {
  const run = thread.latestRun;
  if (run?.status !== "completed" && run?.status !== "interrupted") return null;
  const completedAt = firstValidTimestamp(run.completedAt);
  const startedAt = firstValidTimestamp(run.startedAt, run.requestedAt);
  if (completedAt === null || startedAt === null) return null;

  const completedMs = Date.parse(completedAt);
  const startedMs = Date.parse(startedAt);
  if (completedMs < startedMs) return null;

  return {
    completedAt,
    durationMs: completedMs - startedMs,
  };
}

export function shouldShowSidebarDoneStatus(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  interactionMode: SidebarThreadSummary["interactionMode"];
  hasActionableProposedPlan: boolean;
  completedTiming: CompletedTurnTiming | null;
}): boolean {
  if (input.status !== "ready") return false;
  // Preserve the existing unread badge even when timing is incomplete.
  if (input.isUnread) return true;
  // A read plan prompt needs a decision; durable Done must not replace it.
  if (input.interactionMode === "plan" && input.hasActionableProposedPlan) return false;
  return input.completedTiming !== null;
}

/** The sidebar's compact relative label: "now", "5m", "2h". */
export function formatSidebarRelativeTimeLabel(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}
