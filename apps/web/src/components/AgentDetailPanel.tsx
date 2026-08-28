import type { SubagentDetailEntry } from "@t3tools/client-runtime/state/subagent-detail";
import {
  activityBelongsToSubagent,
  deriveSubagentDetailEntries,
} from "@t3tools/client-runtime/state/subagent-detail";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationAgentActivitySnapshot,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeft,
  Brain,
  Check,
  CircleDot,
  FileDiff,
  MessageSquareText,
  RotateCw,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  agentDetailIdentity,
  createAgentDetailPaginationState,
  reduceAgentDetailPagination,
  resolveAgentDetailPageWindow,
} from "./AgentDetailPanel.logic";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "~/providerModels";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";

const DETAIL_PAGE_SIZE = 50;
const LIVE_REFRESH_MAX_ATTEMPTS = 3;
const LIVE_REFRESH_RETRY_DELAY_MS = 100;
const LIVE_REFRESH_CATCH_UP_WARNING = "Saved child activity is still catching up.";

const DETAIL_ICONS = {
  message: MessageSquareText,
  reasoning: Brain,
  tool: Wrench,
  result: Check,
  diff: FileDiff,
  usage: CircleDot,
  status: CircleDot,
} as const;

function formatClockTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function elapsedText(startedAt: string, completedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes === 0) return `${totalSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`
    : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function DetailElapsed({ agent }: { agent: RuntimeSubagent }) {
  const ref = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  useEffect(() => {
    if (!live || !agent.startedAt) return;
    const update = () => {
      if (ref.current && agent.startedAt) {
        ref.current.textContent = elapsedText(agent.startedAt, null);
      }
    };
    update();
    const intervalId = window.setInterval(update, 1_000);
    return () => window.clearInterval(intervalId);
  }, [agent.startedAt, live]);
  if (!agent.startedAt) return null;
  return <span ref={ref}>{elapsedText(agent.startedAt, live ? null : agent.completedAt)}</span>;
}

function formatStructuredData(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function newerSnapshot(
  left: OrchestrationAgentActivitySnapshot | undefined,
  right: OrchestrationAgentActivitySnapshot | undefined,
): OrchestrationAgentActivitySnapshot | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const leftThreadSequence = left.page.threadSequence ?? -1;
  const rightThreadSequence = right.page.threadSequence ?? -1;
  return rightThreadSequence > leftThreadSequence ||
    (rightThreadSequence === leftThreadSequence &&
      right.page.snapshotSequence > left.page.snapshotSequence)
    ? right
    : left;
}

function DetailActivityRow({ entry }: { entry: SubagentDetailEntry }) {
  const Icon = DETAIL_ICONS[entry.kind];
  return (
    <article className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 border-b border-border/40 px-3 py-2.5 last:border-b-0">
      <Icon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="min-w-0 truncate text-xs font-medium">{entry.title}</h3>
          {entry.status ? (
            <span className="shrink-0 font-mono text-[.65rem] text-muted-foreground">
              {entry.status}
            </span>
          ) : null}
          <time className="ml-auto shrink-0 font-mono text-[.65rem] text-muted-foreground/70">
            {formatClockTime(entry.createdAt)}
          </time>
        </div>
        {entry.detail ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85">
            {entry.detail}
          </p>
        ) : null}
        {entry.data === null || entry.data === undefined ? null : (
          <StructuredActivityData entry={entry} />
        )}
        {entry.truncated ? (
          <span className="mt-1 block text-[.65rem] text-muted-foreground">
            Partial · bounded by server
          </span>
        ) : null}
      </div>
    </article>
  );
}

function StructuredActivityData({ entry }: { entry: SubagentDetailEntry }) {
  const [open, setOpen] = useState(false);
  const structured = open ? formatStructuredData(entry.data) : null;
  return (
    <details className="mt-1.5 text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-[.7rem] text-muted-foreground hover:text-foreground">
        {entry.kind === "diff" ? "Changed files" : "Details"}
      </summary>
      {structured ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/35 p-2 font-mono text-[.68rem] leading-relaxed text-foreground/80">
          {structured}
        </pre>
      ) : null}
    </details>
  );
}

interface AgentDetailPanelProps {
  readonly agent: RuntimeSubagent;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly liveActivities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onBack: () => void;
}

function AgentDetailPanelSession({
  agent,
  environmentId,
  threadId,
  liveActivities,
  onBack,
}: AgentDetailPanelProps) {
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const providerSupportsDetail =
    agent.provider === null || agent.provider === "codex" || agent.provider === "claudeAgent";
  const queryTarget = useMemo(
    () =>
      providerSupportsDetail && environmentId !== null && threadId !== null
        ? {
            environmentId,
            input: { threadId, agentId: agent.id, limit: DETAIL_PAGE_SIZE },
          }
        : null,
    [agent.id, environmentId, providerSupportsDetail, threadId],
  );
  const query = useEnvironmentQuery(
    queryTarget === null ? null : orchestrationEnvironment.agentActivity(queryTarget),
  );
  const loadAgentActivity = useAtomCommand(orchestrationEnvironment.agentActivity.load, {
    label: "agents:load-agent-activity",
    reportFailure: false,
  });
  const [pagination, dispatchPagination] = useReducer(reduceAgentDetailPagination, undefined, () =>
    createAgentDetailPaginationState(),
  );
  const [refreshedSnapshot, setRefreshedSnapshot] = useState<OrchestrationAgentActivitySnapshot>();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const querySnapshot = query.data?.agentId === agent.id ? query.data : undefined;
  const latestSnapshot = newerSnapshot(querySnapshot, refreshedSnapshot);
  const latestSnapshotRef = useRef<typeof latestSnapshot>(latestSnapshot);
  const generationRef = useRef(0);
  if (latestSnapshot !== undefined && latestSnapshotRef.current !== latestSnapshot) {
    latestSnapshotRef.current = latestSnapshot;
    generationRef.current += 1;
  }
  const snapshotGeneration = generationRef.current;
  const requestGuardRef = useRef({
    identity: agentDetailIdentity(environmentId, threadId, agent.id),
    generation: snapshotGeneration,
    enabled: queryTarget !== null,
  });
  requestGuardRef.current = {
    identity: agentDetailIdentity(environmentId, threadId, agent.id),
    generation: snapshotGeneration,
    enabled: queryTarget !== null,
  };
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const catchUpRef = useRef({ targetSequence: -1, attempts: 0, halted: false });
  const performRefreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (pagination.generation === snapshotGeneration) return;
    dispatchPagination({ type: "reset", generation: snapshotGeneration });
  }, [pagination.generation, snapshotGeneration]);
  const activePagination =
    pagination.generation === snapshotGeneration
      ? pagination
      : createAgentDetailPaginationState(snapshotGeneration);

  useEffect(() => {
    const frame = requestAnimationFrame(() => backButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [agent.id]);

  const ownedLiveActivities = useMemo(
    () => liveActivities.filter((activity) => activityBelongsToSubagent(activity, agent.id)),
    [agent.id, liveActivities],
  );
  const ownedLiveMaxSequence = useMemo(() => {
    let maximum = -1;
    for (const activity of ownedLiveActivities) {
      if (activity.sequence !== undefined) maximum = Math.max(maximum, activity.sequence);
    }
    return maximum;
  }, [ownedLiveActivities]);

  const scheduleRefresh = useCallback((delayMs: number) => {
    if (
      refreshTimerRef.current !== null ||
      refreshInFlightRef.current ||
      catchUpRef.current.halted ||
      !requestGuardRef.current.enabled
    ) {
      return;
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      performRefreshRef.current();
    }, delayMs);
  }, []);

  performRefreshRef.current = () => {
    const guard = requestGuardRef.current;
    const catchUp = catchUpRef.current;
    if (
      !guard.enabled ||
      queryTarget === null ||
      refreshInFlightRef.current ||
      catchUp.halted ||
      catchUp.targetSequence < 0 ||
      catchUp.attempts >= LIVE_REFRESH_MAX_ATTEMPTS
    ) {
      return;
    }

    const requestedIdentity = guard.identity;
    const requestedGeneration = guard.generation;
    const requestedSequence = catchUp.targetSequence;
    catchUp.attempts += 1;
    refreshInFlightRef.current = true;
    void loadAgentActivity({
      environmentId: queryTarget.environmentId,
      input: queryTarget.input,
    }).then((result) => {
      refreshInFlightRef.current = false;
      const currentGuard = requestGuardRef.current;
      const currentCatchUp = catchUpRef.current;
      if (!currentGuard.enabled || currentGuard.identity !== requestedIdentity) return;

      if (currentGuard.generation !== requestedGeneration) {
        currentCatchUp.attempts = Math.max(0, currentCatchUp.attempts - 1);
        if (
          (latestSnapshotRef.current?.page.threadSequence ?? -1) < currentCatchUp.targetSequence
        ) {
          scheduleRefresh(0);
        }
        return;
      }

      if (result._tag !== "Success" || result.value.agentId !== agent.id) {
        currentCatchUp.halted = true;
        setRefreshError(
          result._tag === "Failure"
            ? formatEnvironmentQueryError(result.cause)
            : "The saved child activity response did not match this agent.",
        );
        return;
      }

      setRefreshedSnapshot((current) => newerSnapshot(current, result.value));
      if ((result.value.page.threadSequence ?? -1) >= currentCatchUp.targetSequence) {
        currentCatchUp.halted = false;
        setRefreshError(null);
        return;
      }

      if (currentCatchUp.targetSequence > requestedSequence) {
        scheduleRefresh(0);
        return;
      }
      if (currentCatchUp.attempts < LIVE_REFRESH_MAX_ATTEMPTS) {
        scheduleRefresh(LIVE_REFRESH_RETRY_DELAY_MS);
        return;
      }
      currentCatchUp.halted = true;
      setRefreshError(LIVE_REFRESH_CATCH_UP_WARNING);
    });
  };

  useEffect(() => {
    if (
      queryTarget === null ||
      ownedLiveMaxSequence < 0 ||
      ownedLiveMaxSequence <= (latestSnapshot?.page.threadSequence ?? -1)
    ) {
      return;
    }
    const catchUp = catchUpRef.current;
    if (ownedLiveMaxSequence > catchUp.targetSequence) {
      catchUp.targetSequence = ownedLiveMaxSequence;
      catchUp.attempts = 0;
      catchUp.halted = false;
      setRefreshError(null);
    }
    scheduleRefresh(0);
  }, [latestSnapshot, ownedLiveMaxSequence, queryTarget, scheduleRefresh]);

  useEffect(
    () => () => {
      requestGuardRef.current.enabled = false;
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    },
    [],
  );

  const backfill = useMemo(
    () => [...activePagination.activities, ...(latestSnapshot?.activities ?? [])],
    [activePagination.activities, latestSnapshot?.activities],
  );
  const entries = useMemo(
    () =>
      deriveSubagentDetailEntries({
        agentId: agent.id,
        backfill,
        live: ownedLiveActivities,
      }),
    [agent.id, backfill, ownedLiveActivities],
  );
  const { hasMore, beforeCursor } = resolveAgentDetailPageWindow(activePagination, latestSnapshot);

  const loadEarlier = async () => {
    if (!queryTarget || !beforeCursor || activePagination.loading) return;
    const generation = activePagination.generation;
    dispatchPagination({ type: "load-started", generation });
    const result = await loadAgentActivity({
      environmentId: queryTarget.environmentId,
      input: { ...queryTarget.input, beforeCursor },
    });
    if (result._tag === "Success") {
      dispatchPagination({ type: "load-succeeded", generation, snapshot: result.value });
    } else {
      dispatchPagination({
        type: "load-failed",
        generation,
        error: formatEnvironmentQueryError(result.cause),
      });
    }
  };

  const retryDurableLoad = () => {
    setRefreshError(null);
    const targetSequence = catchUpRef.current.targetSequence;
    if (
      queryTarget !== null &&
      targetSequence >= 0 &&
      targetSequence > (latestSnapshotRef.current?.page.threadSequence ?? -1)
    ) {
      catchUpRef.current.attempts = 0;
      catchUpRef.current.halted = false;
      scheduleRefresh(0);
      return;
    }
    query.refresh();
  };

  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null,
    agent.usage?.toolUses === undefined ? null : `${agent.usage.toolUses} tools`,
  ].filter((value): value is string => value !== null);
  const durableError = refreshError ?? query.error;
  const durableLoadWarning =
    durableError && entries.length > 0
      ? durableError === LIVE_REFRESH_CATCH_UP_WARNING
        ? durableError
        : ownedLiveActivities.length > 0
          ? "Saved activity could not be loaded. Live updates are still shown."
          : "Saved activity could not be refreshed. Previously loaded activity is still shown."
      : null;
  const durableAnnouncement = durableError
    ? (durableLoadWarning ?? "Could not load saved child activity.")
    : query.isPending && latestSnapshot === undefined
      ? "Loading saved child activity."
      : latestSnapshot
        ? "Saved child activity loaded."
        : "";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
    >
      <p className="sr-only" aria-live="polite">
        {durableAnnouncement}
      </p>
      <header className="border-b border-border/60 px-2 py-2">
        <div className="flex items-center gap-2">
          <Button
            ref={backButtonRef}
            size="icon-sm"
            variant="ghost-muted"
            onClick={onBack}
            aria-label="Back to agents"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Button>
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              agent.status === "failed"
                ? "bg-destructive"
                : agent.status === "completed"
                  ? "bg-success"
                  : agent.status === "running" || agent.status === "waiting"
                    ? "bg-info"
                    : "bg-muted-foreground/60",
            )}
          />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">{agent.title}</h2>
            <p className="truncate font-mono text-[.68rem] text-muted-foreground">
              <span>{agent.status}</span>
              {agent.startedAt ? (
                <>
                  <span> · </span>
                  <DetailElapsed agent={agent} />
                </>
              ) : null}
              {metadata.length > 0 ? <span> · {metadata.join(" · ")}</span> : null}
            </p>
          </div>
          <span className="ml-auto rounded-sm border border-border/60 px-1.5 py-0.5 text-[.65rem] text-muted-foreground">
            Read only
          </span>
        </div>
      </header>

      {!providerSupportsDetail ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <CircleDot aria-hidden className="size-5 text-muted-foreground/60" />
          <p className="text-sm font-medium">Child detail unavailable</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            {formatProviderDriverKindLabel(agent.provider)} does not expose durable child activity
            in this release.
          </p>
        </div>
      ) : environmentId === null || threadId === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          This agent is not attached to a server thread.
        </div>
      ) : durableError && entries.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium">Could not load child activity</p>
          <p className="max-w-72 text-xs text-muted-foreground">{durableError}</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              retryDurableLoad();
            }}
          >
            <RotateCw aria-hidden className="size-3" />
            Retry
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div aria-busy={query.isPending && entries.length === 0}>
            {durableLoadWarning ? (
              <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                <span>{durableLoadWarning}</span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => {
                    retryDurableLoad();
                  }}
                  className="ml-auto shrink-0"
                >
                  <RotateCw aria-hidden className="size-3" />
                  Retry
                </Button>
              </div>
            ) : null}
            {hasMore && beforeCursor ? (
              <div className="border-b border-border/40 p-2 text-center">
                <button
                  type="button"
                  disabled={activePagination.loading}
                  onClick={() => void loadEarlier()}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:cursor-default"
                >
                  {activePagination.loading ? "Loading earlier activity…" : "Load earlier activity"}
                </button>
                {activePagination.error ? (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {activePagination.error}
                  </p>
                ) : null}
              </div>
            ) : null}
            {entries.length > 0 ? (
              entries.map((entry) => <DetailActivityRow key={entry.id} entry={entry} />)
            ) : query.isPending ? (
              <p className="p-6 text-center text-xs text-muted-foreground">
                Loading child activity…
              </p>
            ) : (
              <p className="p-6 text-center text-xs text-muted-foreground">
                No detailed activity was retained for this agent.
              </p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export function AgentDetailPanel(props: AgentDetailPanelProps) {
  const identity = agentDetailIdentity(props.environmentId, props.threadId, props.agent.id);
  return <AgentDetailPanelSession key={identity} {...props} />;
}
