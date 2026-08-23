import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as WorktrunkHookRunner from "../worktrunk/WorktrunkHookRunner.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeThreadWorktreeIntegrationsFork } from "./ThreadLaunchService.fork.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread-worktree-integrations");
const projectCwd = "/repo/project";
const worktreePath = "/repo/worktrees/feature";

interface Calls {
  readonly bind: Array<{ readonly path: string; readonly projectPath: string | undefined }>;
  readonly createHooks: Array<WorktrunkHookRunner.WorktrunkCreateHooksInput>;
}

const integrationLayers = (options: {
  readonly bind: ZmuxSessionBinder.ZmuxBindResult;
  readonly createHooks: WorktrunkHookRunner.WorktrunkHookResult;
  readonly calls: Calls;
}) =>
  Layer.mergeAll(
    Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
      bind: (path, bindOptions) =>
        Effect.sync(() => {
          options.calls.bind.push({ path, projectPath: bindOptions?.projectPath });
          return options.bind;
        }),
    }),
    Layer.mock(WorktrunkHookRunner.WorktrunkHookRunner)({
      runCreateHooks: (input) =>
        Effect.sync(() => {
          options.calls.createHooks.push(input);
          return options.createHooks;
        }),
    }),
    WorktreeSetupTracker.layer,
    IdAllocator.layer,
  );

/** Runs the post-create step for a launch already tracking its checkout stage. */
const integrate = (strategy: { readonly type: string; readonly worktrunk?: boolean }) =>
  Effect.gen(function* () {
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    yield* tracker.begin({
      threadId,
      branch: "feature",
      baseRef: "main",
      stages: ["fetch", "checkout", "setup-script", "agent"],
      fiber: null,
    });
    yield* tracker.stageStatus(threadId, "checkout", "done");
    const run = yield* makeThreadWorktreeIntegrationsFork;
    yield* run({ threadId, projectCwd, worktreePath, strategy });
    const snapshot = yield* tracker.get(threadId);
    return snapshot?.stages.find((stage) => stage.id === "checkout");
  });

describe("thread launch worktree integrations (fork)", () => {
  it.effect("binds the zmux session and runs Worktrunk create hooks for a Worktrunk launch", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrate({ type: "worktree", worktrunk: true }).pipe(
      Effect.map((checkout) => {
        assert.deepStrictEqual(calls.bind, [{ path: worktreePath, projectPath: projectCwd }]);
        assert.deepStrictEqual(calls.createHooks, [{ projectCwd, worktreePath }]);
        assert.strictEqual(checkout?.status, "done");
        assert.strictEqual(checkout?.detail, "zmux session created");
      }),
      Effect.provide(
        integrationLayers({
          bind: { status: "bound", target: "project/feature", outcome: "created" },
          createHooks: { status: "completed" },
          calls,
        }),
      ),
    );
  });

  it.effect("records a bind failure and a hook failure as a checkout warning", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrate({ type: "worktree", worktrunk: true }).pipe(
      Effect.map((checkout) => {
        assert.strictEqual(checkout?.status, "warning");
        assert.strictEqual(
          checkout?.detail,
          "zmux session failed to bind: branch_conflict; Worktrunk pre-start hook failed: exit 1",
        );
      }),
      Effect.provide(
        integrationLayers({
          bind: {
            status: "failed",
            notice: { summary: "zmux session failed to bind", detail: "branch_conflict" },
          },
          createHooks: {
            status: "failed",
            operation: "pre-start",
            detail: "exit 1",
            exitCode: 1,
            timedOut: false,
          },
          calls,
        }),
      ),
    );
  });

  it.effect("leaves Worktrunk hooks alone for a plain worktree launch", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrate({ type: "worktree" }).pipe(
      Effect.map((checkout) => {
        assert.strictEqual(calls.bind.length, 1);
        assert.deepStrictEqual(calls.createHooks, []);
        assert.strictEqual(checkout?.status, "done");
        assert.strictEqual(checkout?.detail, null);
      }),
      Effect.provide(
        integrationLayers({
          bind: { status: "disabled" },
          createHooks: { status: "completed" },
          calls,
        }),
      ),
    );
  });

  it.effect("warns when a Worktrunk launch reaches a server without the hook runner", () =>
    integrate({ type: "worktree", worktrunk: true }).pipe(
      Effect.map((checkout) => {
        assert.strictEqual(checkout?.status, "warning");
        assert.strictEqual(checkout?.detail, "Worktrunk hooks unavailable on this server");
      }),
      Effect.provide(Layer.merge(WorktreeSetupTracker.layer, IdAllocator.layer)),
    ),
  );
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in worktree integration tests"),
} as ProviderAdapterV2Shape;

/** The integration layers over a real orchestrator, so notices reach the stored projection. */
const persistedLayers = (options: Parameters<typeof integrationLayers>[0]) => {
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-worktree-integrations" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
  );
  return Layer.mergeAll(
    integrationLayers(options),
    orchestrator,
    ThreadManagement.layer.pipe(Layer.provide(orchestrator)),
  );
};

/** Creates the thread, runs the Worktrunk post-create step, and reads back its stored notices. */
const integrateStored = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command:create-thread"),
    threadId,
    projectId: ProjectId.make("project:worktree-integrations"),
    title: "Thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* integrate({ type: "worktree", worktrunk: true });
  const records = yield* threads.getThreadRecords(threadId, ["turnItems"]);
  return records.turnItems.flatMap((item) => (item.type === "system_notice" ? [item] : []));
});

describe("thread launch worktree integration notices (fork)", () => {
  it.effect("persists a bind and hook failure as a stored thread notice", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrateStored.pipe(
      Effect.map((notices) => {
        assert.deepStrictEqual(
          notices.map((notice) => ({ runId: notice.runId, message: notice.message })),
          [
            {
              runId: null,
              message:
                "zmux session failed to bind: branch_conflict; Worktrunk pre-start hook failed: exit 1",
            },
          ],
        );
      }),
      Effect.provide(
        persistedLayers({
          bind: {
            status: "failed",
            notice: { summary: "zmux session failed to bind", detail: "branch_conflict" },
          },
          createHooks: {
            status: "failed",
            operation: "pre-start",
            detail: "exit 1",
            exitCode: 1,
            timedOut: false,
          },
          calls,
        }),
      ),
    );
  });

  it.effect("stores no notice when the session binds and the hooks pass", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrateStored.pipe(
      Effect.map((notices) => assert.deepStrictEqual(notices, [])),
      Effect.provide(
        persistedLayers({
          bind: { status: "bound", target: "project/feature", outcome: "created" },
          createHooks: { status: "completed" },
          calls,
        }),
      ),
    );
  });
});
