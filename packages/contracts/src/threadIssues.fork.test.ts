import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  ClientOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "./orchestration.ts";

const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

const thread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: null,
};

// A client from before issue links: the same thread schemas without `issues`.
const PreFeatureThread = OrchestrationThread.mapFields(Struct.omit(["issues"]));
const PreFeatureThreadShell = OrchestrationThreadShell.mapFields(Struct.omit(["issues"]));
const encodeThread = Schema.encodeEffect(OrchestrationThread);
const encodeShell = Schema.encodeEffect(OrchestrationThreadShell);
const decodeShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const decodePreFeatureThread = Schema.decodeUnknownEffect(PreFeatureThread);
const decodePreFeatureShell = Schema.decodeUnknownEffect(PreFeatureThreadShell);

const key = { host: "github.com", repository: "acme/web", number: 7 };
const snapshot = { title: "Fix it", state: "open", syncedAt: "2026-09-01T00:00:01.000Z" } as const;

it.effect("a thread from a server without issue links decodes unchanged, with none", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeThread(thread);
    assert.isFalse("issues" in decoded);
    assert.deepStrictEqual(decoded.issues ?? [], []);
  }),
);

it.effect("a thread keeps its linked issues", () =>
  Effect.gen(function* () {
    const link = {
      ...key,
      url: "https://github.com/acme/web/issues/7",
      source: "handoff" as const,
      linkedAt: "2026-09-01T00:00:00.000Z",
      snapshot,
    };
    assert.deepStrictEqual((yield* decodeThread({ ...thread, issues: [link] })).issues, [link]);
  }),
);

it.effect("a client from before issue links reads a linked thread and shell, ignoring them", () =>
  Effect.gen(function* () {
    const link = {
      ...key,
      url: "https://github.com/acme/web/issues/7",
      source: "manual" as const,
      linkedAt: "2026-09-01T00:00:00.000Z",
      snapshot,
    };
    // Encode as the new server sends it, then decode with the old client schema.
    const full = yield* decodeThread({ ...thread, issues: [link] });
    const fullWire = yield* encodeThread(full);
    const oldFull = yield* decodePreFeatureThread(fullWire);
    assert.isFalse("issues" in oldFull);
    assert.strictEqual(oldFull.title, "Thread");

    const shell = yield* decodeShell({
      ...Struct.omit(thread, ["deletedAt", "messages", "activities", "checkpoints"]),
      issues: [link],
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });
    assert.deepStrictEqual(shell.issues, [link]);
    const oldShell = yield* decodePreFeatureShell(yield* encodeShell(shell));
    assert.isFalse("issues" in oldShell);
  }),
);

it.effect("clients link and unlink issues but cannot forge a sync", () =>
  Effect.gen(function* () {
    const base = { commandId: "cmd-1", threadId: "thread-1", ...key };
    const link = yield* decodeClientCommand({
      ...base,
      type: "thread.issue.link",
      url: "https://github.com/acme/web/issues/7",
      source: "manual",
    });
    assert.strictEqual(link.type, "thread.issue.link");
    const unlink = yield* decodeClientCommand({ ...base, type: "thread.issue.unlink" });
    assert.strictEqual(unlink.type, "thread.issue.unlink");
    const sync = { ...base, type: "thread.issue-link.sync", snapshot };
    assert.strictEqual((yield* decodeCommand(sync)).type, "thread.issue-link.sync");
    assert.strictEqual((yield* Effect.exit(decodeClientCommand(sync)))._tag, "Failure");
  }),
);

it.effect("issue link events decode as orchestration events", () =>
  Effect.gen(function* () {
    const event = yield* decodeEvent({
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-09-01T00:00:02.000Z",
      commandId: "cmd-1",
      causationEventId: null,
      correlationId: "cmd-1",
      metadata: {},
      type: "thread.issue-synced",
      payload: { threadId: "thread-1", ...key, snapshot, updatedAt: "2026-09-01T00:00:02.000Z" },
    });
    assert.strictEqual(event.type, "thread.issue-synced");
  }),
);
