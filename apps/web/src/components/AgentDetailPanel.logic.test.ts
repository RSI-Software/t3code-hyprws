import type { OrchestrationAgentActivitySnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_DETAIL_MAX_RETAINED_ACTIVITIES,
  agentDetailIdentity,
  createAgentDetailPaginationState,
  reduceAgentDetailPagination,
  resolveAgentDetailPageWindow,
} from "./AgentDetailPanel.logic";

function snapshot(
  ids: ReadonlyArray<string>,
  beforeCursor: string | null,
  hasMore: boolean,
): OrchestrationAgentActivitySnapshot {
  return {
    agentId: "agent-1",
    activities: ids.map((id, sequence) => ({
      id,
      tone: "tool",
      kind: "tool.completed",
      summary: id,
      payload: { agentId: "agent-1" },
      turnId: null,
      sequence,
      createdAt: `2026-08-01T10:00:0${sequence}.000Z`,
      truncated: false,
    })),
    page: {
      beforeCursor,
      hasMore,
      snapshotSequence: 10,
      threadSequence: 5,
    },
  } as unknown as OrchestrationAgentActivitySnapshot;
}

describe("agent detail pagination", () => {
  it("keys pagination by environment, thread, and agent identity", () => {
    const current = agentDetailIdentity("environment-1", "thread-1", "agent-1");

    expect(agentDetailIdentity("environment-2", "thread-1", "agent-1")).not.toBe(current);
    expect(agentDetailIdentity("environment-1", "thread-2", "agent-1")).not.toBe(current);
    expect(agentDetailIdentity("environment-1", "thread-1", "agent-2")).not.toBe(current);
    expect(agentDetailIdentity(null, null, "agent-1")).not.toBe(current);
  });

  it("prepends older pages and advances their cursor", () => {
    const initial = createAgentDetailPaginationState(2);
    const loaded = reduceAgentDetailPagination(initial, {
      type: "load-succeeded",
      generation: 2,
      snapshot: snapshot(["older-1", "older-2"], "cursor-2", true),
    });
    const next = reduceAgentDetailPagination(loaded, {
      type: "load-succeeded",
      generation: 2,
      snapshot: snapshot(["oldest"], null, false),
    });

    expect(next.activities.map((activity) => activity.id)).toEqual([
      "oldest",
      "older-1",
      "older-2",
    ]);
    expect(resolveAgentDetailPageWindow(next, undefined)).toEqual({
      hasMore: false,
      beforeCursor: null,
    });
  });

  it("ignores a page that resolves after the latest query generation changes", () => {
    const reset = reduceAgentDetailPagination(createAgentDetailPaginationState(1), {
      type: "reset",
      generation: 2,
    });
    const stale = reduceAgentDetailPagination(reset, {
      type: "load-succeeded",
      generation: 1,
      snapshot: snapshot(["stale"], null, false),
    });

    expect(stale).toBe(reset);
    expect(stale.activities).toEqual([]);
  });

  it("ignores an in-flight failure after the latest query generation changes", () => {
    const reset = reduceAgentDetailPagination(createAgentDetailPaginationState(4), {
      type: "reset",
      generation: 5,
    });
    const stale = reduceAgentDetailPagination(reset, {
      type: "load-failed",
      generation: 4,
      error: "stale failure",
    });

    expect(stale).toBe(reset);
    expect(stale.error).toBeNull();
  });

  it("uses the latest durable page until an older page is loaded", () => {
    expect(
      resolveAgentDetailPageWindow(
        createAgentDetailPaginationState(),
        snapshot([], "cursor-1", true),
      ),
    ).toEqual({ hasMore: true, beforeCursor: "cursor-1" });
  });

  it("bounds retained older rows and closes pagination at the retention limit", () => {
    const ids = Array.from(
      { length: AGENT_DETAIL_MAX_RETAINED_ACTIVITIES + 10 },
      (_, index) => `activity-${index}`,
    );
    const loaded = reduceAgentDetailPagination(createAgentDetailPaginationState(), {
      type: "load-succeeded",
      generation: 0,
      snapshot: snapshot(ids, "more-rows", true),
    });

    expect(loaded.activities).toHaveLength(AGENT_DETAIL_MAX_RETAINED_ACTIVITIES);
    expect(loaded.activities[0]?.id).toBe("activity-10");
    expect(resolveAgentDetailPageWindow(loaded, undefined)).toEqual({
      hasMore: false,
      beforeCursor: "more-rows",
    });
  });
});
