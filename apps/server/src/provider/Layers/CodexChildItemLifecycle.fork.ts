// custom-agents — extracted on RSI-Software/t3code-hyprws#674 PR 2.
//
// The collabAgent/item child-item lifecycle mapping for Codex child work. The
// adapter keeps a single marked call; everything below is fork-owned, so the
// sync walk re-applies one hook instead of the whole woven branch. The
// adapter's item vocabulary (canonical types, titles, details) is injected at
// the call site so this sibling never imports CodexAdapter back.

import {
  type CanonicalItemType,
  ProviderItemId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
} from "@t3tools/contracts";

import { truncateActivityDetail } from "../../activityDetail.ts";
import { extractChildItemResultText, makeChildItemRenderDetail } from "../childItemRenderDetail.ts";

/**
 * The adapter's item helpers, injected so fork code composes upstream's exact
 * vocabulary without an import cycle. Method-style signatures keep parameter
 * checking bivariant across the adapter's internal item types.
 */
export interface CodexChildItemHelpers {
  toCanonicalItemType(raw: string | undefined | null): CanonicalItemType;
  itemTitle(itemType: CanonicalItemType, item?: object): string | undefined;
  itemDetail(itemType: CanonicalItemType, item: object): string | undefined;
}

/** Structural view of the raw collabAgent item; only lifecycle fields are named. */
type CodexChildLifecycleItem = Record<string, unknown> & {
  readonly id: unknown;
  readonly status?: unknown;
  readonly aggregatedOutput?: unknown;
  readonly command?: unknown;
  readonly changes?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly contentItems?: unknown;
  readonly type?: unknown;
};

export interface CodexChildItemLifecycleInput {
  /** The runtime event base shared by every event mapped from this notification. */
  readonly base: Omit<ProviderRuntimeEvent, "type" | "payload">;
  readonly payload: Record<string, unknown>;
  readonly item: Record<string, unknown>;
  readonly itemTypeRaw: string;
  readonly agentThreadId: string;
  readonly workspaceRoot?: string | undefined;
  readonly helpers: CodexChildItemHelpers;
}

function childItemRenderDetail(item: CodexChildLifecycleItem, workspaceRoot?: string) {
  const resultSource =
    item.aggregatedOutput ??
    (item.type === "mcpToolCall" ? (item.result ?? item.error) : undefined) ??
    (item.type === "dynamicToolCall" ? item.contentItems : undefined);
  const result = extractChildItemResultText(resultSource);
  return makeChildItemRenderDetail({
    ...(workspaceRoot ? { workspaceRoot } : {}),
    command: item.command,
    ...(result.value ? { result: result.value } : {}),
    ...(Array.isArray(item.changes) ? { changedFiles: item.changes } : {}),
    truncated: result.truncated,
  });
}

/**
 * Maps a typed collabAgent/item lifecycle (started/updated/completed) into one
 * attributed runtime event. Returns `undefined` when the notification carries
 * no lifecycle, so the adapter falls through to its loose-summary mapping.
 */
export function mapCodexChildItemLifecycleEvents(
  input: CodexChildItemLifecycleInput,
): ReadonlyArray<ProviderRuntimeEvent> | undefined {
  const lifecycle =
    input.payload.lifecycle === "item.started" ||
    input.payload.lifecycle === "item.updated" ||
    input.payload.lifecycle === "item.completed"
      ? input.payload.lifecycle
      : undefined;
  const itemId = typeof input.item.id === "string" ? input.item.id : undefined;
  if (!lifecycle || !itemId) {
    return undefined;
  }
  const item = input.item as unknown as CodexChildLifecycleItem;
  const canonical = input.helpers.toCanonicalItemType(input.itemTypeRaw);
  const detail = input.helpers.itemDetail(canonical, item);
  const renderDetail = childItemRenderDetail(item, input.workspaceRoot);
  const title = input.helpers.itemTitle(canonical, item);
  const terminalStatus =
    item.status === "failed" || item.status === "declined" ? item.status : undefined;
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : terminalStatus
        ? terminalStatus
        : lifecycle === "item.completed"
          ? "completed"
          : "inProgress";
  const providerItemId = ProviderItemId.make(itemId);
  const providerRefs = {
    ...input.base.providerRefs,
    providerItemId,
  };
  return [
    {
      ...input.base,
      itemId: RuntimeItemId.make(providerItemId),
      providerRefs,
      type: lifecycle,
      payload: {
        itemType: canonical,
        status,
        ...(title ? { title } : {}),
        ...(detail ? { detail: truncateActivityDetail(detail) } : {}),
        ...(renderDetail ? { renderDetail } : {}),
        data: { item: input.item },
        agentId: input.agentThreadId,
        timelineBypass: true,
      },
    },
  ];
}
