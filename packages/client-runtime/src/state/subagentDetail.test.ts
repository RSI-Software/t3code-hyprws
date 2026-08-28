import type { OrchestrationAgentActivity, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentDetailEntries, SUBAGENT_DETAIL_MAX_ENTRIES } from "./subagentDetail.ts";

function activity(
  id: string,
  kind: string,
  sequence: number | undefined,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id,
    tone: "tool",
    kind,
    summary: kind,
    payload,
    turnId: null,
    ...(sequence === undefined ? {} : { sequence }),
    createdAt: `2026-08-01T10:00:${String(sequence ?? 59).padStart(2, "0")}.000Z`,
  } as OrchestrationThreadActivity;
}

function durable(
  id: string,
  kind: string,
  sequence: number | undefined,
  payload: Record<string, unknown>,
  truncated = false,
): OrchestrationAgentActivity {
  return { ...activity(id, kind, sequence, payload), truncated };
}

describe("deriveSubagentDetailEntries", () => {
  it("merges detail backfill with live rows, filters ownership, and collapses tool lifecycle", () => {
    const live = [
      activity("tool-start", "tool.started", 1, {
        agentId: "agent-1",
        toolCallId: "tool-1",
        itemType: "command_execution",
        detail: "running",
      }),
      activity("foreign", "tool.completed", 2, {
        agentId: "other-agent",
        toolCallId: "other-tool",
        detail: "foreign",
      }),
    ];
    const backfill = [
      durable("tool-complete", "tool.completed", 3, {
        agentId: "agent-1",
        toolCallId: "tool-1",
        itemType: "command_execution",
        detail: "finished",
        data: { result: "done" },
      }),
      durable("message", "tool.completed", 4, {
        agentId: "agent-1",
        toolCallId: "tool-2",
        itemType: "assistant_message",
        detail: "Child report",
      }),
      durable(
        "task-complete",
        "task.completed",
        5,
        { taskId: "agent-1", status: "completed", detail: "All done" },
        true,
      ),
    ];

    const entries = deriveSubagentDetailEntries({ agentId: "agent-1", backfill, live });
    expect(entries.map((entry) => entry.kind)).toEqual(["tool", "message", "result"]);
    expect(entries[0]).toMatchObject({ detail: "finished", data: { result: "done" } });
    expect(entries[2]).toMatchObject({ detail: "All done", truncated: true });
    expect(entries.some((entry) => entry.detail === "foreign")).toBe(false);
  });

  it("sorts a collapsed lifecycle by its final row rather than its start", () => {
    const entries = deriveSubagentDetailEntries({
      agentId: "agent-1",
      backfill: [
        durable("tool-start", "tool.started", 1, {
          agentId: "agent-1",
          toolCallId: "tool-1",
        }),
        durable("status", "task.progress", 2, {
          taskId: "agent-1",
          detail: "Still working",
        }),
        durable("tool-complete", "tool.completed", 3, {
          agentId: "agent-1",
          toolCallId: "tool-1",
          detail: "Finished",
        }),
      ],
      live: [],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["status", "tool-complete"]);
  });

  it("sorts mixed legacy and sequenced rows by sequence fallback before timestamps", () => {
    const entries = deriveSubagentDetailEntries({
      agentId: "agent-1",
      backfill: [
        durable("sequenced", "task.progress", 0, {
          taskId: "agent-1",
          detail: "Sequenced",
        }),
        durable("legacy", "task.progress", undefined, {
          taskId: "agent-1",
          detail: "Legacy",
        }),
      ],
      live: [],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["legacy", "sequenced"]);
  });

  it("recognizes reasoning, diffs, and usage rows", () => {
    const backfill = [
      durable("reasoning", "tool.completed", 1, {
        agentId: "agent-1",
        itemType: "reasoning",
        detail: "Analyzing",
      }),
      durable("diff", "tool.completed", 2, {
        agentId: "agent-1",
        itemType: "file_change",
        files: [{ path: "src/index.ts" }],
      }),
      durable("usage", "task.progress", 3, {
        taskId: "agent-1",
        typedUsage: { totalTokens: 1200 },
      }),
    ];

    expect(
      deriveSubagentDetailEntries({ agentId: "agent-1", backfill, live: [] }).map(
        (entry) => entry.kind,
      ),
    ).toEqual(["reasoning", "diff", "usage"]);
  });

  it("prefers Codex command and result render detail and propagates its truncation", () => {
    const [entry] = deriveSubagentDetailEntries({
      agentId: "codex-child",
      backfill: [
        durable("codex-command", "tool.completed", 1, {
          agentId: "codex-child",
          itemType: "command_execution",
          data: { providerNative: "discarded fallback" },
          renderDetail: {
            command: "bun test src/child.test.ts",
            result: "1 test passed",
            truncated: true,
          },
        }),
      ],
      live: [],
    });

    expect(entry).toMatchObject({
      kind: "tool",
      data: {
        command: "bun test src/child.test.ts",
        result: "1 test passed",
      },
      truncated: true,
    });
  });

  it("classifies Claude changed-file render detail as a diff and preserves row truncation", () => {
    const [entry] = deriveSubagentDetailEntries({
      agentId: "claude-task",
      backfill: [
        durable(
          "claude-edit",
          "tool.completed",
          1,
          {
            agentId: "claude-task",
            itemType: "tool_use",
            data: { providerNative: "discarded fallback" },
            renderDetail: {
              changedFiles: [{ path: "src/child.ts", kind: "modified", diff: "@@ -1 +1 @@" }],
              truncated: false,
            },
          },
          true,
        ),
      ],
      live: [],
    });

    expect(entry).toMatchObject({
      kind: "diff",
      data: {
        changedFiles: [{ path: "src/child.ts", kind: "modified", diff: "@@ -1 +1 @@" }],
      },
      truncated: true,
    });
  });

  it("never exposes hostile live detail or data when safe render detail is present", () => {
    const [entry] = deriveSubagentDetailEntries({
      agentId: "agent-1",
      backfill: [],
      live: [
        activity("live-tool", "tool.completed", 1, {
          agentId: "agent-1",
          itemType: "command_execution",
          detail: "SECRET /home/user/private.txt",
          data: { secret: "host-token" },
          renderDetail: {
            command: "bun test safe.test.ts",
            result: "1 test passed",
            truncated: false,
          },
        }),
      ],
    });

    expect(entry).toMatchObject({
      detail: null,
      data: { command: "bun test safe.test.ts", result: "1 test passed" },
    });
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(JSON.stringify(entry)).not.toContain("host-token");
  });

  it("uses bounded durable fallback for a historical copy of a live row", () => {
    const live = activity("shared", "tool.completed", 1, {
      agentId: "agent-1",
      detail: "unprojected live secret",
      data: { secret: "live-secret" },
    });
    const backfill = durable("shared", "tool.completed", 1, {
      agentId: "agent-1",
      detail: "Projected historical detail",
      data: { result: "retained result" },
    });

    const [entry] = deriveSubagentDetailEntries({
      agentId: "agent-1",
      backfill: [backfill],
      live: [live],
    });

    expect(entry).toMatchObject({
      detail: "Projected historical detail",
      data: { result: "retained result" },
    });
    expect(JSON.stringify(entry)).not.toContain("live-secret");
  });

  it("suppresses oversized durable fallback data and marks the row partial", () => {
    const [entry] = deriveSubagentDetailEntries({
      agentId: "agent-1",
      backfill: [
        durable("oversized", "tool.completed", 1, {
          agentId: "agent-1",
          detail: "d".repeat(5_000),
          data: { result: "x".repeat(12_000) },
        }),
      ],
      live: [],
    });

    expect(entry?.detail).toHaveLength(4_096);
    expect(entry).toMatchObject({ data: null, truncated: true });
  });

  it("rejects invalid live render detail instead of falling back to raw fields", () => {
    const [entry] = deriveSubagentDetailEntries({
      agentId: "agent-1",
      backfill: [],
      live: [
        activity("invalid", "tool.completed", 1, {
          agentId: "agent-1",
          detail: "raw detail",
          data: { secret: true },
          renderDetail: {
            changedFiles: [{ path: "x".repeat(300), diff: "private" }],
            truncated: false,
          },
        }),
      ],
    });

    expect(entry).toMatchObject({ detail: null, data: null });
  });

  it("caps the derived list to bound retained DOM work", () => {
    const backfill = Array.from({ length: SUBAGENT_DETAIL_MAX_ENTRIES + 25 }, (_, index) =>
      durable(`row-${index}`, "task.progress", index, { taskId: "agent-1" }),
    );

    const entries = deriveSubagentDetailEntries({ agentId: "agent-1", backfill, live: [] });

    expect(entries).toHaveLength(SUBAGENT_DETAIL_MAX_ENTRIES);
    expect(entries[0]?.id).toBe("row-25");
    expect(entries.at(-1)?.id).toBe(`row-${SUBAGENT_DETAIL_MAX_ENTRIES + 24}`);
  });
});
