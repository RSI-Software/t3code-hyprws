// custom-agents — extracted on RSI-Software/t3code-hyprws#674 PR 2.
//
// Which provider runtime item-lifecycle events persist into thread activity,
// and which payload fields ride along. The upstream ingestion switch keeps one
// marked import and calls these helpers at the same three lifecycle cases.

import { type ProviderRuntimeEvent, isToolLifecycleItemType } from "@t3tools/contracts";

export function isPersistableItemLifecycle(event: ProviderRuntimeEvent): boolean {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return false;
  }
  return (
    isToolLifecycleItemType(event.payload.itemType) ||
    (event.payload.agentId !== undefined && event.payload.timelineBypass === true)
  );
}

export function persistedItemLifecycleDetail(
  event: Extract<
    ProviderRuntimeEvent,
    { readonly type: "item.started" | "item.updated" | "item.completed" }
  >,
): { readonly data?: unknown; readonly renderDetail?: unknown } {
  const attributed = event.payload.agentId !== undefined && event.payload.timelineBypass === true;
  return {
    ...(!attributed && event.payload.data !== undefined ? { data: event.payload.data } : {}),
    ...(event.payload.renderDetail !== undefined
      ? { renderDetail: event.payload.renderDetail }
      : {}),
  };
}
