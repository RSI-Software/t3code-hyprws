// @vitest-environment happy-dom
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AgentsPanel } from "./AgentsPanel";

function agent(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: id,
    role: null,
    model: null,
    effort: null,
    provider: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-08-01T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function model(input: {
  directAgents?: ReadonlyArray<RuntimeSubagent>;
  workflows?: ReadonlyArray<AgentPanelWorkflowGroup>;
}): AgentPanelModel {
  const directAgents = input.directAgents ?? [];
  const workflows = input.workflows ?? [];
  return {
    directAgents,
    workflows,
    runningCount: 1,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: directAgents.length + workflows.length > 0,
    liveCount: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AgentsPanel accessibility and focus", () => {
  it("exposes row status, activity, and usage through the button's descendant text", async () => {
    const probe = agent("probe", {
      title: "Code probe",
      progress: "Inspecting provider output",
      usage: { totalTokens: 1_200, toolUses: 3 },
    });

    await act(() => root.render(<AgentsPanel model={model({ directAgents: [probe] })} />));

    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Code probe"),
    );
    expect(button?.getAttribute("aria-label")).toBeNull();
    expect(button?.textContent).toContain("Inspecting provider output");
    expect(button?.textContent).toContain("1.2k tok");
    expect(button?.textContent).toContain("3 tools");
    expect(button?.textContent).toContain("Working");
  });

  it("focuses the rendered workflow header when the coordinator owns the focus request", async () => {
    const coordinator = agent("workflow-1", {
      kind: "workflow",
      title: "Review fleet",
      workflowName: "Review fleet",
    });
    const member = agent("worker-1", { kind: "workflow_agent", parentAgentId: coordinator.id });
    const workflow = {
      workflow: coordinator,
      phases: [],
      unphasedMembers: [member],
    } satisfies AgentPanelWorkflowGroup;
    const onSelectionChange = vi.fn();

    await act(() =>
      root.render(
        <AgentsPanel
          model={model({ workflows: [workflow] })}
          rosterFocusAgentId={coordinator.id}
          onSelectionChange={onSelectionChange}
        />,
      ),
    );

    const collapse = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Review fleet workflow"]',
    );
    expect(collapse).not.toBeNull();
    expect(document.activeElement).toBe(collapse);
    expect(onSelectionChange).toHaveBeenCalledWith(null, null);
  });

  it("restores focus to the empty roster after Back from a missing child", async () => {
    const emptyModel = model({});
    const onSelectionChange = vi.fn();
    await act(() =>
      root.render(
        <AgentsPanel
          model={emptyModel}
          selectedAgentId="missing-agent"
          onSelectionChange={onSelectionChange}
        />,
      ),
    );

    const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back to agents"]');
    expect(back).not.toBeNull();
    await act(() => back?.click());
    expect(onSelectionChange).toHaveBeenCalledWith(null, null);
    await act(() =>
      root.render(<AgentsPanel model={emptyModel} onSelectionChange={onSelectionChange} />),
    );

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLElement>('[aria-label="Agents roster"]'),
      ),
    );
  });

  it("restores focus to the empty roster after Escape from a missing child", async () => {
    const emptyModel = model({});
    const onSelectionChange = vi.fn();
    await act(() =>
      root.render(
        <AgentsPanel
          model={emptyModel}
          selectedAgentId="missing-agent"
          onSelectionChange={onSelectionChange}
        />,
      ),
    );

    const detail = container.querySelector("header")?.parentElement;
    expect(detail).not.toBeNull();
    await act(() =>
      detail?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onSelectionChange).toHaveBeenCalledWith(null, null);
    await act(() =>
      root.render(<AgentsPanel model={emptyModel} onSelectionChange={onSelectionChange} />),
    );

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector<HTMLElement>('[aria-label="Agents roster"]'),
      ),
    );
  });
});
