import { assert, describe, it } from "vite-plus/test";

import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";
import { routeCodexChildNotification } from "./CodexSessionRuntime.ts";

describe("routeCodexChildNotification", () => {
  it("maps child item deltas to agent events", () => {
    for (const method of [
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/commandExecution/outputDelta",
      "item/commandExecution/terminalInteraction",
      "item/fileChange/outputDelta",
      "item/fileChange/patchUpdated",
      "item/plan/delta",
    ]) {
      assert.equal(routeCodexChildNotification(method), "agent-event", method);
    }
  });

  forkSupersedes({
    upstream:
      "apps/server/src/provider/Layers/CodexCollabWire.test.ts > drops only enumerated child chatter",
    reason:
      "the fork streams a child agent's item deltas into its transcript, so they map to agent events instead of dropping",
    commit: "d2001b9930a",
  });
  it("drops only the child chatter the fork does not stream", () => {
    for (const method of ["turn/plan/updated", "thread/name/updated"]) {
      assert.equal(routeCodexChildNotification(method), "drop", method);
    }
  });
});
