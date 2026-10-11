import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { describe, expect, it } from "vite-plus/test";

import { summarizeServerUpdates } from "./components/chat/useAutoBalanceUpdateBanner";
import { dismissServerUpdateFailure, isServerUpdateFailureDismissed } from "./versionSkew";

describe("server update terminal notices", () => {
  it("dismisses completion only for that attempt, without clearing its confirmed version", () => {
    const completed = {
      status: "completed",
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
    } as const satisfies ServerUpdateState;
    expect(isServerUpdateFailureDismissed(completed)).toBe(false);
    dismissServerUpdateFailure(completed);
    expect(isServerUpdateFailureDismissed(completed)).toBe(true);
    expect(completed.targetVersion).toBe("1.0.1");
    expect(isServerUpdateFailureDismissed({ ...completed })).toBe(false);
    const running = { ...completed, status: "running", stage: "resuming" } as const;
    dismissServerUpdateFailure(running);
    expect(isServerUpdateFailureDismissed(running)).toBe(false);
  });

  it("counts only machines still needing an update while others completed", () => {
    const completed = {
      status: "completed",
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
    } as const;
    expect(summarizeServerUpdates([completed, { status: "idle" }])).toEqual({
      status: "idle",
      title: "Update available for 1 machine",
    });
    expect(summarizeServerUpdates([completed, completed])).toEqual({
      status: "completed",
      title: "Updated 2 machines",
    });
  });
});
