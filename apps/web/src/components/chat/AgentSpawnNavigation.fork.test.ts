import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createAgentSpawnOpenHandler } from "./AgentSpawnNavigation";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("project-window-environment"),
  ThreadId.make("project-window-thread"),
);
const otherWindowThreadRef = scopeThreadRef(
  EnvironmentId.make("other-environment"),
  ThreadId.make("project-window-thread"),
);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

function openSpawn(input: {
  workflowId: string | null;
  agentTaskIds: ReadonlyArray<string>;
  visibleAgentIds: ReadonlyArray<string>;
}) {
  createAgentSpawnOpenHandler({
    ...input,
    onOpenAgents: (
      selectedAgentId: string | null = null,
      rosterFocusAgentId: string | null = null,
    ) => {
      useRightPanelStore.getState().openAgents(threadRef, {
        selectedAgentId,
        rosterFocusAgentId,
      });
    },
  })();
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);
}

describe("createAgentSpawnOpenHandler", () => {
  it("opens an attributed direct child in its project-window thread", () => {
    expect(
      openSpawn({
        workflowId: null,
        agentTaskIds: ["agent-1"],
        visibleAgentIds: ["agent-1"],
      }),
    ).toMatchObject({
      kind: "agents",
      selectedAgentId: "agent-1",
      rosterFocusAgentId: null,
    });
    expect(
      selectActiveRightPanelSurface(
        useRightPanelStore.getState().byThreadKey,
        otherWindowThreadRef,
      ),
    ).toBeNull();
  });

  it("opens a workflow's sole child instead of its coordinator", () => {
    expect(
      openSpawn({
        workflowId: "workflow-1",
        agentTaskIds: ["workflow-1", "agent-1"],
        visibleAgentIds: ["agent-1"],
      }),
    ).toMatchObject({ selectedAgentId: "agent-1", rosterFocusAgentId: null });
  });

  it("opens a fleet roster focused on its first visible child", () => {
    expect(
      openSpawn({
        workflowId: null,
        agentTaskIds: ["agent-1", "agent-2"],
        visibleAgentIds: ["agent-2", "agent-1"],
      }),
    ).toMatchObject({ selectedAgentId: null, rosterFocusAgentId: "agent-2" });
  });
});
