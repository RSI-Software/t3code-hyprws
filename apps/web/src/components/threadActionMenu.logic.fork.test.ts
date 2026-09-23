import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasManualOrder: false,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems reset order (fork)", () => {
  it("offers reset order only while the thread carries a manual order key", () => {
    expect(ids(baseState)).not.toContain("reset-order");
    const item = buildThreadActionMenuItems({ ...baseState, hasManualOrder: true }).find(
      (candidate) => candidate.id === "reset-order",
    );
    expect(item).toMatchObject({ label: "Reset order", icon: "arrow-down-up" });
  });

  it("orders reset before the lifecycle actions", () => {
    const items = buildThreadActionMenuItems({ ...baseState, hasManualOrder: true });
    const resetIndex = items.findIndex((item) => item.id === "reset-order");
    const settleIndex = items.findIndex((item) => item.id === "settle");
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeLessThan(settleIndex);
  });
});
