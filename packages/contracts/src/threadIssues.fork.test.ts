import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
} from "./orchestrationV2.ts";

const decodeThread = Schema.decodeUnknownEffect(OrchestrationV2AppThreadJson);
const encodeThread = Schema.encodeEffect(OrchestrationV2AppThreadJson);
const decodeClientCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);

const thread = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
};

// A client from before issue links: the same thread schema without `issues`.
const PreFeatureThread = OrchestrationV2AppThreadJson.mapFields(Struct.omit(["issues"]));
const decodePreFeatureThread = Schema.decodeUnknownEffect(PreFeatureThread);

const key = { host: "github.com", repository: "acme/web", number: 7 };
const snapshot = { title: "Fix it", state: "open", syncedAt: "2026-09-01T00:00:01.000Z" } as const;
const link = {
  ...key,
  url: "https://github.com/acme/web/issues/7",
  source: "handoff" as const,
  linkedAt: "2026-09-01T00:00:00.000Z",
  snapshot,
};

it.effect("a thread from a server without issue links decodes unchanged, with none", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeThread(thread);
    assert.isFalse("issues" in decoded);
    assert.deepStrictEqual(decoded.issues ?? [], []);
  }),
);

it.effect("a thread keeps its linked issues through the stored payload codec", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeThread({ ...thread, issues: [link] });
    assert.deepStrictEqual(decoded.issues, [link]);
    assert.deepStrictEqual((yield* encodeThread(decoded)).issues, [link]);
  }),
);

it.effect("a client from before issue links reads a linked thread, ignoring them", () =>
  Effect.gen(function* () {
    const wire = yield* encodeThread(yield* decodeThread({ ...thread, issues: [link] }));
    const old = yield* decodePreFeatureThread(wire);
    assert.isFalse("issues" in old);
    assert.strictEqual(old.title, "Thread");
  }),
);

it.effect("clients link and unlink issues but cannot forge a sync", () =>
  Effect.gen(function* () {
    const base = { commandId: "cmd-1", threadId: "thread-1", ...key };
    const linked = yield* decodeClientCommand({
      ...base,
      type: "thread.issue.link",
      url: "https://github.com/acme/web/issues/7",
      source: "manual",
    });
    assert.strictEqual(linked.type, "thread.issue.link");
    const unlinked = yield* decodeClientCommand({ ...base, type: "thread.issue.unlink" });
    assert.strictEqual(unlinked.type, "thread.issue.unlink");
    const sync = { ...base, type: "thread.issue-link.sync", snapshot };
    assert.strictEqual((yield* Effect.exit(decodeClientCommand(sync)))._tag, "Failure");
    // The server-side union still names the sync, so only the server dispatches it.
    const serverSync: Extract<
      OrchestrationV2ServerCommand,
      { type: "thread.issue-link.sync" }
    >["type"] = "thread.issue-link.sync";
    assert.strictEqual(serverSync, sync.type);
  }),
);
