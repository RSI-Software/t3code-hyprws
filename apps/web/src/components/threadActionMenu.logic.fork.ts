import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId, ThreadActionMenuState } from "./threadActionMenu.logic.ts";

/**
 * Fork: the way back from a manual order key to automatic ordering.
 * Returns the Reset order entry only while the thread carries a manual
 * activeOrderKey; selecting it dispatches the existing active-reorder
 * write with a null key.
 */
export function resetOrderMenuItems(
  state: Pick<ThreadActionMenuState, "hasManualOrder">,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return state.hasManualOrder
    ? [{ id: "reset-order" as const, label: "Reset order", icon: "arrow-down-up" }]
    : [];
}
