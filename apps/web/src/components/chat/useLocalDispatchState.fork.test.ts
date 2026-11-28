import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { createLocalDispatchSnapshot } from "../ChatView.logic";
import { updateWorktrunkDispatchFork } from "./useLocalDispatchState.fork";

it.each([false, true])(
  "preserves provider selection when Worktrunk preparation changes from %s",
  (preparingWorktrunk) => {
    const active = createLocalDispatchSnapshot(undefined, {
      preparingWorktrunk,
      providerInstanceId: ProviderInstanceId.make("old-provider"),
    });
    const update = {
      preparingWorktree: !preparingWorktrunk,
      preparingWorktrunk: !preparingWorktrunk,
      submissionIntent: "background" as const,
      providerInstanceId: ProviderInstanceId.make("new-provider"),
    };
    expect(updateWorktrunkDispatchFork(active, update)).toEqual({ ...active, ...update });
    expect(active.preparingWorktrunk).toBe(preparingWorktrunk);
    expect(updateWorktrunkDispatchFork(active, { ...update, preparingWorktrunk })).toBeNull();
  },
);
