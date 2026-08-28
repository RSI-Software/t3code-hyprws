import type {
  ChildItemRenderChangedFile,
  ChildItemRenderDetail,
  OrchestrationAgentActivity,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  CHILD_ITEM_RENDER_CHANGED_FILES_MAX_ITEMS,
  CHILD_ITEM_RENDER_COMMAND_MAX_CHARS,
  CHILD_ITEM_RENDER_DIFF_MAX_CHARS,
  CHILD_ITEM_RENDER_JSON_MAX_BYTES,
  CHILD_ITEM_RENDER_PATH_MAX_CHARS,
  CHILD_ITEM_RENDER_RESULT_MAX_CHARS,
} from "@t3tools/contracts";

export const SUBAGENT_DETAIL_MAX_ENTRIES = 250;

export type SubagentDetailEntryKind =
  | "message"
  | "reasoning"
  | "tool"
  | "result"
  | "diff"
  | "usage"
  | "status";

export interface SubagentDetailEntry {
  readonly id: string;
  readonly kind: SubagentDetailEntryKind;
  readonly activityKind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly itemType: string | null;
  readonly status: string | null;
  readonly data: unknown;
  readonly createdAt: string;
  readonly sequence: number | null;
  readonly truncated: boolean;
}

type AgentDetailActivity = OrchestrationAgentActivity | OrchestrationThreadActivity;

interface SourcedAgentDetailActivity {
  readonly activity: AgentDetailActivity;
  readonly durable: boolean;
}

interface SubagentRenderDetail {
  readonly data: Omit<ChildItemRenderDetail, "truncated"> | null;
  readonly hasChangedFiles: boolean;
  readonly truncated: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function activityPayload(activity: AgentDetailActivity): Record<string, unknown> {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function renderChangedFile(value: unknown): ChildItemRenderChangedFile | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isBoundedString(candidate.path, CHILD_ITEM_RENDER_PATH_MAX_CHARS) ||
    candidate.path.trim().length === 0 ||
    (candidate.kind !== undefined &&
      candidate.kind !== "added" &&
      candidate.kind !== "modified" &&
      candidate.kind !== "deleted") ||
    (candidate.diff !== undefined &&
      !isBoundedString(candidate.diff, CHILD_ITEM_RENDER_DIFF_MAX_CHARS))
  ) {
    return null;
  }
  return {
    path: candidate.path,
    ...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
    ...(candidate.diff === undefined ? {} : { diff: candidate.diff }),
  };
}

function subagentRenderDetail(payload: Record<string, unknown>): SubagentRenderDetail | null {
  if (typeof payload.renderDetail !== "object" || payload.renderDetail === null) return null;
  const renderDetail = payload.renderDetail as Record<string, unknown>;
  if (
    typeof renderDetail.truncated !== "boolean" ||
    (renderDetail.command !== undefined &&
      !isBoundedString(renderDetail.command, CHILD_ITEM_RENDER_COMMAND_MAX_CHARS)) ||
    (renderDetail.result !== undefined &&
      !isBoundedString(renderDetail.result, CHILD_ITEM_RENDER_RESULT_MAX_CHARS)) ||
    (renderDetail.changedFiles !== undefined &&
      (!Array.isArray(renderDetail.changedFiles) ||
        renderDetail.changedFiles.length > CHILD_ITEM_RENDER_CHANGED_FILES_MAX_ITEMS))
  ) {
    return null;
  }
  let changedFiles: ReadonlyArray<ChildItemRenderChangedFile> | undefined;
  if (Array.isArray(renderDetail.changedFiles)) {
    const validated = renderDetail.changedFiles.map(renderChangedFile);
    if (validated.some((file) => file === null)) return null;
    changedFiles = validated as ReadonlyArray<ChildItemRenderChangedFile>;
  }
  try {
    if (
      new TextEncoder().encode(JSON.stringify(renderDetail)).byteLength >
      CHILD_ITEM_RENDER_JSON_MAX_BYTES
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const command = renderDetail.command as string | undefined;
  const result = renderDetail.result as string | undefined;
  const hasChangedFiles = changedFiles !== undefined;
  const data =
    command !== undefined || result !== undefined || changedFiles !== undefined
      ? {
          ...(command === undefined ? {} : { command }),
          ...(result === undefined ? {} : { result }),
          ...(changedFiles === undefined ? {} : { changedFiles }),
        }
      : null;
  return { data, hasChangedFiles, truncated: renderDetail.truncated };
}

interface DurableFallback {
  readonly data: unknown;
  readonly detail: string | null;
  readonly truncated: boolean;
}

function boundedDurableFallback(payload: Record<string, unknown>): DurableFallback {
  const rawDetail = asString(payload.detail) ?? asString(payload.summary);
  const detail = rawDetail?.slice(0, CHILD_ITEM_RENDER_RESULT_MAX_CHARS) ?? null;
  const rawData = payload.data ?? payload.typedUsage ?? payload.usage ?? null;
  if (rawData === null) {
    return {
      data: null,
      detail,
      truncated: rawDetail !== null && rawDetail.length > CHILD_ITEM_RENDER_RESULT_MAX_CHARS,
    };
  }
  try {
    const serialized = JSON.stringify(rawData);
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).byteLength > CHILD_ITEM_RENDER_JSON_MAX_BYTES
    ) {
      return { data: null, detail, truncated: true };
    }
  } catch {
    return { data: null, detail, truncated: true };
  }
  return {
    data: rawData,
    detail,
    truncated: rawDetail !== null && rawDetail.length > CHILD_ITEM_RENDER_RESULT_MAX_CHARS,
  };
}

/** Client-side defense for merging the server-filtered page with live thread rows. */
export function activityBelongsToSubagent(activity: AgentDetailActivity, agentId: string): boolean {
  const payload = activityPayload(activity);
  return asString(payload.agentId) === agentId || asString(payload.taskId) === agentId;
}

function classifySubagentDetailEntry(
  activityKind: string,
  payload: Record<string, unknown>,
  renderDetail: SubagentRenderDetail | null,
  durable: boolean,
): SubagentDetailEntryKind {
  const itemType = asString(payload.itemType);
  if (itemType === "assistant_message") return "message";
  if (itemType === "reasoning" || activityKind.includes("reasoning")) return "reasoning";
  if (
    itemType === "file_change" ||
    activityKind.includes("diff") ||
    renderDetail?.hasChangedFiles === true ||
    (durable && (Array.isArray(payload.files) || Array.isArray(payload.changes)))
  ) {
    return "diff";
  }
  if (durable && (payload.typedUsage !== undefined || payload.usage !== undefined)) return "usage";
  if (activityKind === "task.completed") return "result";
  if (activityKind.startsWith("tool.") && activityKind !== "tool.progress") return "tool";
  return "status";
}

function detailLifecycleKey(activity: AgentDetailActivity): string {
  const payload = activityPayload(activity);
  const toolCallId = asString(payload.toolCallId);
  return toolCallId && activity.kind.startsWith("tool.")
    ? `tool:${toolCallId}`
    : `activity:${activity.id}`;
}

function compareDetailActivity(left: AgentDetailActivity, right: AgentDetailActivity): number {
  return (
    (left.sequence ?? -1) - (right.sequence ?? -1) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Merge durable detail-grade pages with the selected thread's live summary
 * rows. Backfill wins duplicate ids because it retains the richer bounded
 * payload; a newer tool lifecycle replaces its earlier start/update row.
 */
export function deriveSubagentDetailEntries({
  agentId,
  backfill,
  live,
}: {
  readonly agentId: string;
  readonly backfill: ReadonlyArray<OrchestrationAgentActivity>;
  readonly live: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyArray<SubagentDetailEntry> {
  const mergedById = new Map<string, SourcedAgentDetailActivity>();
  for (const activity of live) {
    if (activityBelongsToSubagent(activity, agentId)) {
      mergedById.set(activity.id, { activity, durable: false });
    }
  }
  for (const activity of backfill) {
    if (activityBelongsToSubagent(activity, agentId)) {
      mergedById.set(activity.id, { activity, durable: true });
    }
  }

  const lifecycle = new Map<string, SourcedAgentDetailActivity>();
  for (const sourced of [...mergedById.values()].sort((left, right) =>
    compareDetailActivity(left.activity, right.activity),
  )) {
    lifecycle.set(detailLifecycleKey(sourced.activity), sourced);
  }

  return [...lifecycle.values()]
    .sort((left, right) => compareDetailActivity(left.activity, right.activity))
    .slice(-SUBAGENT_DETAIL_MAX_ENTRIES)
    .map(({ activity, durable }) => {
      const payload = activityPayload(activity);
      const renderDetail = subagentRenderDetail(payload);
      const fallback = durable
        ? boundedDurableFallback(payload)
        : { data: null, detail: null, truncated: false };
      return {
        id: activity.id,
        kind: classifySubagentDetailEntry(activity.kind, payload, renderDetail, durable),
        activityKind: activity.kind,
        title: activity.summary,
        detail: fallback.detail,
        itemType: asString(payload.itemType),
        status: asString(payload.status),
        data: renderDetail?.data ?? fallback.data,
        createdAt: activity.createdAt,
        sequence: activity.sequence ?? null,
        truncated:
          renderDetail?.truncated === true ||
          fallback.truncated ||
          (durable && "truncated" in activity && activity.truncated),
      };
    });
}
