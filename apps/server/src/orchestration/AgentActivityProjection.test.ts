import {
  EventId,
  OrchestrationAgentActivity,
  OrchestrationAgentActivitySnapshot,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
  projectAgentActivity,
} from "./AgentActivityProjection.ts";

const decodeAgentActivity = Schema.decodeUnknownSync(OrchestrationAgentActivity);
const encodeAgentActivity = Schema.encodeUnknownSync(OrchestrationAgentActivity);
const encodeAgentActivitySnapshot = Schema.encodeUnknownSync(OrchestrationAgentActivitySnapshot);

function activity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Read /home/alice/private/project/file.ts",
    payload,
    turnId: null,
    sequence: 7,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("projectAgentActivity", () => {
  it("removes local paths while preserving relative diff paths", () => {
    const projected = projectAgentActivity(
      activity({
        agentId: "agent-1",
        runHandles: {
          runId: "run-1",
          scriptPath: "/home/alice/.claude/projects/workflow.js",
          transcriptDir: "/home/alice/.claude/transcripts/run-1",
          sessionUrl: "https://example.test/session/1",
        },
        files: [
          { path: "src/index.ts" },
          { path: "/home/alice/private/secret.ts" },
          { path: String.raw`C:\Users\alice\secret.txt` },
          { path: String.raw`\\server\share\secret.txt` },
          { path: "//server/share/secret.txt" },
          { path: String.raw`~\private\secret.txt` },
        ],
        pathKeys: [
          { "/home/alice/private.ts": "posix" },
          { [String.raw`C:\Users\alice\secret.txt`]: "drive" },
          { [String.raw`\\server\share\secret.txt`]: "unc" },
          { "//server/share/secret.txt": "posix-double-slash" },
          { [String.raw`~\private\secret.txt`]: "home" },
        ],
        notes: [
          "path:/home/alice/private.txt",
          String.raw`read \\server\share\secret.txt`,
          String.raw`read ~\private\secret.txt`,
          "load //cdn.example.test/app.js",
          "https://example.test/a",
        ],
      }),
    );

    expect(projected.summary).toBe("Read [local path]");
    expect(projected.payload).toEqual({
      agentId: "agent-1",
      runHandles: { runId: "run-1", sessionUrl: "https://example.test/session/1" },
      files: [
        { path: "src/index.ts" },
        { path: "[local path]" },
        { path: "[local path]" },
        { path: "[local path]" },
        { path: "[local path]" },
        { path: "[local path]" },
      ],
      pathKeys: [
        { "[local path]": "posix" },
        { "[local path]": "drive" },
        { "[local path]": "unc" },
        { "[local path]": "posix-double-slash" },
        { "[local path]": "home" },
      ],
      notes: [
        "path:[local path]",
        "read [local path]",
        "read [local path]",
        "load //cdn.example.test/app.js",
        "https://example.test/a",
      ],
    });
    expect(projected.truncated).toBe(true);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("/home/alice");
    expect(serialized).not.toContain(String.raw`C:\Users\alice`);
    expect(serialized).not.toContain(String.raw`\\server\share`);
    expect(serialized).not.toContain(String.raw`~\private`);
  });

  it("redacts shell-delimited and quoted local paths without changing URLs or prose", () => {
    const projected = projectAgentActivity(
      activity({
        details: [
          "cat>/home/alice/private.txt",
          String.raw`type<C:\Users\alice\private.txt`,
          String.raw`cmd|\\server\share\private.txt`,
          "cmd&/home/alice/private.txt",
          "cat>//server/share/private.txt",
          "type<//server/share/private.txt",
          "cmd|//server/share/private.txt",
          "cmd&//server/share/private.txt",
          "read ~alice/private.txt",
          'open "/home/alice/My Secrets/private.txt"',
          String.raw`open 'C:\Users\alice\My Secrets\private.txt'`,
          String.raw`open "\\server\share\My Secrets\private.txt"`,
          "https://example.test/a/b",
          "http://example.test/a/b",
          'visit "https://example.test/a/b"',
          "load //cdn.example.test/app.js",
          'load "//cdn.example.test/app.js"',
          "compare 1/2 with src/index.ts",
        ],
      }),
    );

    expect(projected.payload).toEqual({
      details: [
        "cat>[local path]",
        "type<[local path]",
        "cmd|[local path]",
        "cmd&[local path]",
        "cat>[local path]",
        "type<[local path]",
        "cmd|[local path]",
        "cmd&[local path]",
        "read [local path]",
        'open "[local path]"',
        "open '[local path]'",
        'open "[local path]"',
        "https://example.test/a/b",
        "http://example.test/a/b",
        'visit "https://example.test/a/b"',
        "load //cdn.example.test/app.js",
        'load "//cdn.example.test/app.js"',
        "compare 1/2 with src/index.ts",
      ],
    });
    expect(projected.truncated).toBe(true);
  });

  it("caps nested strings, collections, and depth and reports truncation", () => {
    const projected = projectAgentActivity(
      activity({
        entries: Array.from({ length: 75 }, (_, index) => ({ index })),
        detail: "x".repeat(20_000),
        deep: { one: { two: { three: { four: { five: { six: "hidden" } } } } } },
      }),
    );

    expect(projected.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
    );
    expect((projected.payload as { entries: unknown[] }).entries).toHaveLength(50);
  });

  it("charges nested primitive structure against the serialized row budget", () => {
    const nestedNumbers = (depth: number): unknown =>
      depth === 0 ? 1 : Array.from({ length: 20 }, () => nestedNumbers(depth - 1));
    const projected = projectAgentActivity(activity({ values: nestedNumbers(4) }));

    expect(projected.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
    );
  });

  it("bounds metadata while preserving schema-valid identifier prefixes and timestamps", () => {
    const oversizedId = "activity-".concat("a".repeat(30_000));
    const oversizedTurnId = "turn-".concat("t".repeat(30_000));
    const projected = projectAgentActivity({
      ...activity({
        values: Array.from({ length: 20 }, () =>
          Array.from({ length: 20 }, () =>
            Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 1)),
          ),
        ),
      }),
      id: EventId.make(oversizedId),
      turnId: TurnId.make(oversizedTurnId),
      createdAt: `2026-08-28T00:00:00.${"1".repeat(30_000)}Z`,
    });

    expect(projected.truncated).toBe(true);
    expect(projected.id).toMatch(/^activity-a+…$/u);
    expect(projected.turnId).toMatch(/^turn-t+…$/u);
    expect(projected.createdAt).toBe("2026-08-28T00:00:00.111Z");
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
    );
    expect(decodeAgentActivity(projected)).toEqual(projected);
    expect(encodeAgentActivity(projected)).toEqual(projected);
    const snapshot = {
      agentId: "agent-1",
      activities: [projected],
      page: {
        beforeCursor: null,
        hasMore: false,
        snapshotSequence: 9,
        threadSequence: 7,
      },
    };
    expect(encodeAgentActivitySnapshot(snapshot)).toEqual(snapshot);
  });

  it("caps multi-megabyte strings before projecting their bounded prefix", () => {
    const detail = `${"x".repeat(2_000_000)}/home/alice/never-scanned.txt`;
    const projected = projectAgentActivity(activity({ detail }));

    expect(projected.truncated).toBe(true);
    expect((projected.payload as { detail: string }).detail).toMatch(/^x+…$/u);
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      AGENT_ACTIVITY_SERIALIZED_MAX_BYTES,
    );
  });
});
