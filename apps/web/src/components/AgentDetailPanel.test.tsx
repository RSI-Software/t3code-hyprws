// @vitest-environment happy-dom
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  EnvironmentId,
  type OrchestrationAgentActivity,
  type OrchestrationAgentActivitySnapshot,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  query: {
    data: null as OrchestrationAgentActivitySnapshot | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
  runQuery: vi.fn(),
  useAtomCommand: vi.fn(),
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    agentActivity: Object.assign(
      vi.fn(() => ({})),
      { load: {} },
    ),
  },
}));
vi.mock("~/state/query", () => ({
  formatEnvironmentQueryError: (cause: unknown) =>
    cause instanceof Error ? cause.message : "older page failed",
  useEnvironmentQuery: () => testState.query,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (...args: ReadonlyArray<unknown>) => {
    testState.useAtomCommand(...args);
    return testState.runQuery;
  },
}));

import { AgentDetailPanel } from "./AgentDetailPanel";
import { orchestrationEnvironment } from "~/state/orchestration";

function agent(id: string, provider: RuntimeSubagent["provider"] = null): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    title: id,
    role: null,
    model: null,
    effort: null,
    provider,
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
  };
}

function snapshot(
  agentId: string,
  ids: ReadonlyArray<string>,
  beforeCursor: string | null,
  hasMore: boolean,
  payload: Record<string, unknown> = {},
  threadSequence = 5,
): OrchestrationAgentActivitySnapshot {
  return {
    agentId,
    activities: ids.map((id, sequence) => ({
      id,
      tone: "tool",
      kind: "tool.completed",
      summary: id,
      payload: { agentId, ...payload },
      turnId: null,
      sequence,
      createdAt: `2026-08-01T10:00:0${sequence}.000Z`,
      truncated: false,
    })),
    page: {
      beforeCursor,
      hasMore,
      snapshotSequence: 10,
      threadSequence,
    },
  } as unknown as OrchestrationAgentActivitySnapshot;
}

function detailedSnapshot(
  agentId: string,
  activities: ReadonlyArray<OrchestrationAgentActivity>,
  threadSequence: number,
): OrchestrationAgentActivitySnapshot {
  return {
    agentId,
    activities,
    page: {
      beforeCursor: null,
      hasMore: false,
      snapshotSequence: threadSequence,
      threadSequence,
    },
  } as OrchestrationAgentActivitySnapshot;
}

function durableActivity(
  id: string,
  agentId: string,
  sequence: number,
  payload: Record<string, unknown>,
): OrchestrationAgentActivity {
  return {
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: id,
    payload: { agentId, ...payload },
    turnId: null,
    sequence,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    truncated: false,
  } as OrchestrationAgentActivity;
}

function liveActivity(agentId: string, sequence: number): OrchestrationThreadActivity {
  return {
    id: `live-${agentId}-${sequence}`,
    tone: "tool",
    kind: "tool.completed",
    summary: `Live update ${sequence}`,
    payload: {
      agentId,
      detail: "raw live secret",
      data: { secret: "raw-live-data" },
    },
    turnId: null,
    sequence,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as OrchestrationThreadActivity;
}

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const codexProvider = ProviderDriverKind.make("codex");
const claudeProvider = ProviderDriverKind.make("claudeAgent");
const cursorProvider = ProviderDriverKind.make("cursor");
let container: HTMLDivElement;
let root: Root;

function panel(
  agentId: string,
  provider: RuntimeSubagent["provider"] = null,
  liveActivities: ReadonlyArray<OrchestrationThreadActivity> = [],
) {
  return (
    <AgentDetailPanel
      agent={agent(agentId, provider)}
      environmentId={environmentId}
      threadId={threadId}
      liveActivities={liveActivities}
      onBack={vi.fn()}
    />
  );
}

function loadEarlierButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Load earlier activity",
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error("load-earlier button is missing");
  return button;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.query = {
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  };
  testState.runQuery.mockReset();
  testState.useAtomCommand.mockReset();
  vi.mocked(orchestrationEnvironment.agentActivity).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AgentDetailPanel pagination boundary", () => {
  it.each([codexProvider, claudeProvider])(
    "queries durable detail for a %s child",
    async (provider) => {
      testState.query.data = snapshot("agent-a", ["supported-row"], null, false);
      await act(() => root.render(panel("agent-a", provider)));

      expect(container.textContent).toContain("supported-row");
      expect(orchestrationEnvironment.agentActivity).toHaveBeenCalledWith({
        environmentId,
        input: { threadId, agentId: "agent-a", limit: 50 },
      });
    },
  );

  it("does not query for a child owned by an explicitly unsupported provider", async () => {
    await act(() => root.render(panel("agent-a", cursorProvider)));

    expect(orchestrationEnvironment.agentActivity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Child detail unavailable");
    expect(container.textContent).toContain("Cursor does not expose durable child activity");
  });

  it("queries for a legacy child whose provider is unknown", async () => {
    testState.query.data = snapshot("agent-a", ["legacy-row"], null, false);
    await act(() => root.render(panel("agent-a", null)));

    expect(container.textContent).toContain("legacy-row");
    expect(orchestrationEnvironment.agentActivity).toHaveBeenCalled();
  });

  it("keeps child-owned detail loaded across composer provider switches", async () => {
    testState.query.data = snapshot("agent-a", ["provider-neutral-row"], null, false);
    const providerPanel = (composerProvider: string) => (
      <div data-composer-provider={composerProvider}>{panel("agent-a")}</div>
    );

    await act(() => root.render(providerPanel("cursor")));
    expect(container.textContent).toContain("provider-neutral-row");
    expect(orchestrationEnvironment.agentActivity).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, agentId: "agent-a", limit: 50 },
    });

    await act(() => root.render(providerPanel("claudeAgent")));
    expect(container.textContent).toContain("provider-neutral-row");
    expect(container.textContent).not.toContain("Child detail unavailable");
  });

  it("coalesces a live sequence advance into one durable refresh", async () => {
    testState.query.data = snapshot("agent-a", [], null, false, {}, 5);
    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: detailedSnapshot(
        "agent-a",
        [
          durableActivity("Child answer", "agent-a", 8, {
            itemType: "assistant_message",
            detail: "Bounded child answer",
          }),
          durableActivity("Child reasoning", "agent-a", 10, {
            itemType: "reasoning",
            detail: "Bounded child reasoning",
          }),
        ],
        10,
      ),
    });
    const live = [liveActivity("agent-a", 8), liveActivity("agent-a", 10)];

    await act(() => root.render(panel("agent-a", codexProvider, live)));
    await vi.waitFor(() => expect(testState.runQuery).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container.textContent).toContain("Bounded child answer"));
    expect(container.textContent).toContain("Bounded child reasoning");
    expect(container.textContent).not.toContain("raw live secret");
    expect(container.textContent).not.toContain("raw-live-data");
    expect(testState.useAtomCommand).toHaveBeenCalledWith(
      orchestrationEnvironment.agentActivity.load,
      expect.objectContaining({ label: "agents:load-agent-activity" }),
    );

    await act(() => root.render(panel("agent-a", codexProvider, [...live])));
    await Promise.resolve();
    expect(testState.runQuery).toHaveBeenCalledTimes(1);
  });

  it("bounds catch-up retries, then allows a manual retry", async () => {
    testState.query.data = snapshot("agent-a", ["retained"], null, false, {}, 2);
    testState.runQuery
      .mockResolvedValueOnce({
        _tag: "Success",
        value: snapshot("agent-a", ["behind-1"], null, false, {}, 3),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: snapshot("agent-a", ["behind-2"], null, false, {}, 3),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: snapshot("agent-a", ["behind-3"], null, false, {}, 3),
      });

    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 4)])));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(testState.runQuery).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Saved child activity is still catching up");
    expect(container.textContent).toContain("behind-1");

    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: snapshot("agent-a", ["caught-up"], null, false, { detail: "Caught up safely" }, 4),
    });
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    await act(async () => {
      retry?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(testState.runQuery).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Caught up safely");
    expect(container.textContent).not.toContain("still catching up");
  });

  it("resets the catch-up budget when a higher live sequence arrives", async () => {
    testState.query.data = snapshot("agent-a", [], null, false, {}, 2);
    testState.runQuery.mockResolvedValue({
      _tag: "Success",
      value: snapshot("agent-a", [], null, false, {}, 3),
    });

    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 4)])));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(testState.runQuery).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("still catching up");

    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: snapshot(
        "agent-a",
        ["sequence-five"],
        null,
        false,
        { detail: "Reached sequence five" },
        5,
      ),
    });
    await act(() => {
      root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 5)]));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(testState.runQuery).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Reached sequence five");
    expect(container.textContent).not.toContain("still catching up");
  });

  it("drops older pagination when a sequence refresh lands a newer snapshot", async () => {
    testState.query.data = snapshot("agent-a", ["latest-old"], "older-cursor", true, {}, 5);
    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: snapshot("agent-a", ["older-page"], null, false, {}, 5),
    });
    await act(() => root.render(panel("agent-a", codexProvider)));
    await act(async () => {
      loadEarlierButton().click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("older-page"));

    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: snapshot("agent-a", ["refreshed-latest"], null, false, {}, 10),
    });
    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 10)])));

    await vi.waitFor(() => expect(container.textContent).toContain("refreshed-latest"));
    expect(container.textContent).not.toContain("older-page");
  });

  it("ignores a durable refresh that resolves after the child identity changes", async () => {
    testState.query.data = snapshot("agent-a", [], null, false, {}, 2);
    let resolveRefresh: ((value: unknown) => void) | undefined;
    testState.runQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 4)])));
    await vi.waitFor(() => expect(testState.runQuery).toHaveBeenCalledTimes(1));

    testState.query.data = snapshot("agent-b", ["agent-b-row"], null, false, {}, 4);
    await act(() => root.render(panel("agent-b", codexProvider)));
    await act(async () => {
      resolveRefresh?.({
        _tag: "Success",
        value: detailedSnapshot(
          "agent-a",
          [durableActivity("stale-secret", "agent-a", 4, { detail: "stale-secret" })],
          4,
        ),
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("agent-b-row");
    expect(container.textContent).not.toContain("stale-secret");
  });

  it("retries a live sequence after an in-flight refresh becomes generation-stale", async () => {
    testState.query.data = snapshot("agent-a", [], null, false, {}, 2);
    let resolveStaleRefresh: ((value: unknown) => void) | undefined;
    testState.runQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleRefresh = resolve;
      }),
    );
    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 4)])));
    await vi.waitFor(() => expect(testState.runQuery).toHaveBeenCalledTimes(1));

    testState.query.data = snapshot("agent-a", ["new-generation"], null, false, {}, 3);
    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: snapshot(
        "agent-a",
        ["fresh-generation-detail"],
        null,
        false,
        { detail: "fresh-generation-detail" },
        4,
      ),
    });
    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 4)])));
    await act(async () => {
      resolveStaleRefresh?.({
        _tag: "Success",
        value: snapshot(
          "agent-a",
          ["stale-generation-detail"],
          null,
          false,
          { detail: "stale-generation-detail" },
          4,
        ),
      });
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(testState.runQuery).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container.textContent).toContain("fresh-generation-detail"));
    expect(container.textContent).not.toContain("stale-generation-detail");
  });

  it("keeps retained content visible when a sequence refresh fails", async () => {
    testState.query.data = snapshot(
      "agent-a",
      ["retained-row"],
      null,
      false,
      { detail: "Previously retained detail" },
      2,
    );
    testState.runQuery.mockResolvedValueOnce({
      _tag: "Failure",
      cause: new Error("refresh failed"),
    });

    await act(() => root.render(panel("agent-a", codexProvider, [liveActivity("agent-a", 4)])));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Saved activity could not be loaded"),
    );

    expect(container.textContent).toContain("Previously retained detail");
    expect(testState.runQuery).toHaveBeenCalledTimes(1);

    testState.runQuery.mockResolvedValueOnce({
      _tag: "Success",
      value: snapshot(
        "agent-a",
        ["recovered-row"],
        null,
        false,
        { detail: "Recovered durable detail" },
        4,
      ),
    });
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    await act(() => retry?.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Recovered durable detail"));
    expect(testState.runQuery).toHaveBeenCalledTimes(2);
  });

  it("formats structured activity only after its disclosure is opened", async () => {
    testState.query.data = snapshot("agent-a", ["structured-row"], null, false, {
      data: { result: "bounded result" },
    });
    await act(() => root.render(panel("agent-a")));

    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    const summary = container.querySelector<HTMLElement>("details summary");
    await act(() => summary?.click());
    expect(container.querySelector("pre")?.textContent).toContain("bounded result");
  });

  it("drops rows, cursor, and errors synchronously when the detail identity changes", async () => {
    testState.query.data = snapshot("agent-a", ["latest-a"], "cursor-a", true);
    testState.runQuery
      .mockResolvedValueOnce({
        _tag: "Success",
        value: snapshot("agent-a", ["older-a"], "cursor-a-2", true),
      })
      .mockResolvedValueOnce({ _tag: "Failure", cause: new Error("older page failed") });
    await act(() => root.render(panel("agent-a")));

    await act(async () => {
      loadEarlierButton().click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.textContent).toContain("older-a"));
    await act(async () => {
      loadEarlierButton().click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    testState.query.data = snapshot("agent-b", ["latest-b"], null, false);
    await act(() => root.render(panel("agent-b")));

    expect(container.textContent).toContain("latest-b");
    expect(container.textContent).not.toContain("latest-a");
    expect(container.textContent).not.toContain("older-a");
    expect(container.textContent).not.toContain("Load earlier activity");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores an earlier-page response after its identity has unmounted", async () => {
    testState.query.data = snapshot("agent-a", ["latest-a"], "cursor-a", true);
    let resolvePage: ((value: unknown) => void) | undefined;
    testState.runQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    await act(() => root.render(panel("agent-a")));
    await act(async () => {
      loadEarlierButton().click();
      await Promise.resolve();
    });

    testState.query.data = snapshot("agent-b", ["latest-b"], null, false);
    await act(() => root.render(panel("agent-b")));
    await act(async () => {
      resolvePage?.({
        _tag: "Success",
        value: snapshot("agent-a", ["late-a"], null, false),
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("latest-b");
    expect(container.textContent).not.toContain("late-a");
    expect(container.textContent).not.toContain("Loading earlier activity…");
  });
});
