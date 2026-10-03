import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as CheckoutMutationCoordinator from "./CheckoutMutationCoordinator.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";
import { sharedCheckoutWsLayerFork } from "./sharedCheckoutGuard.fork.ts";

const projectId = ProjectId.make("project-1");

const shellThread = (
  id: string,
  worktreePath: string | null,
  busy: boolean,
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId,
    worktreePath,
    activeRunId: null,
    activityRunStatus: busy ? "running" : null,
    status: busy ? "running" : "idle",
  }) as unknown as OrchestrationV2ThreadShell;

// /repo is the project checkout; /repo-wt is a separate worktree checkout.
const rootOf = (cwd: string) => (cwd.startsWith("/repo-wt") ? "/repo-wt" : "/repo");

const makeHarness = (input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly log: string[];
  readonly switchGate?: Deferred.Deferred<void>;
  readonly switchEntered?: Deferred.Deferred<void>;
}) => {
  const threadManagement = {
    getShellSnapshot: () => Effect.succeed({ threads: input.threads }),
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(input.threads.find((thread) => thread.id === threadId) ?? null),
    dispatch: () =>
      Effect.sync(() => {
        input.log.push("dispatch");
        return { sequence: 1, storedEvents: [] };
      }),
  } as unknown as ThreadManagement.ThreadManagementService["Service"];
  const gitWorkflow = {
    createRef: (refInput: { readonly refName: string }) =>
      Effect.sync(() => {
        input.log.push("createRef");
        return { refName: refInput.refName };
      }),
    switchRef: (refInput: { readonly refName: string }) =>
      Effect.gen(function* () {
        input.log.push("switch:start");
        if (input.switchEntered) yield* Deferred.succeed(input.switchEntered, undefined);
        if (input.switchGate) yield* Deferred.await(input.switchGate);
        input.log.push("switch:end");
        return { refName: refInput.refName };
      }),
  } as unknown as GitWorkflow.GitWorkflowService["Service"];
  const registry = {
    resolve: ({ cwd }: { readonly cwd: string }) =>
      Effect.succeed({ repository: { rootPath: rootOf(cwd) } }),
  } as unknown as VcsDriverRegistry.VcsDriverRegistry["Service"];
  const projects = {
    getShell: () => Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/repo" })),
  } as unknown as ProjectStore.ProjectStoreV2["Service"];

  return sharedCheckoutWsLayerFork.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, threadManagement),
        Layer.succeed(GitWorkflow.GitWorkflowService, gitWorkflow),
        Layer.succeed(VcsDriverRegistry.VcsDriverRegistry, registry),
        Layer.succeed(ProjectStore.ProjectStoreV2, projects),
        CheckoutMutationCoordinator.layer,
      ),
    ),
  );
};

const messageDispatch = (threadId: string) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(`command-${threadId}`),
    threadId: ThreadId.make(threadId),
    messageId: MessageId.make(`message-${threadId}`),
  }) as unknown as OrchestrationV2Command;

describe("sharedCheckoutWsLayerFork", () => {
  it.effect("refuses a branch switch while a thread on the project checkout is busy", () => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const git = yield* GitWorkflow.GitWorkflowService;
      const error = yield* git.switchRef({ cwd: "/repo", refName: "main" }).pipe(Effect.flip);
      expect(error.detail).toBe(
        "Wait for active turns sharing this checkout to finish before changing branch.",
      );
      const created = yield* git.createRef({ cwd: "/repo", refName: "feature" });
      expect(created.refName).toBe("feature");
      const switching = yield* git
        .createRef({ cwd: "/repo", refName: "other", switchRef: true })
        .pipe(Effect.flip);
      expect(switching.command).toBe("shared-checkout-guard");
      expect(log).toEqual(["createRef"]);
    }).pipe(Effect.provide(makeHarness({ threads: [shellThread("root", null, true)], log })));
  });

  it.effect("switches a checkout whose only busy threads run in another checkout", () => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const git = yield* GitWorkflow.GitWorkflowService;
      yield* git.switchRef({ cwd: "/repo", refName: "main" });
      expect(log).toEqual(["switch:start", "switch:end"]);
    }).pipe(
      Effect.provide(
        makeHarness({
          threads: [shellThread("worktree", "/repo-wt", true), shellThread("root", null, false)],
          log,
        }),
      ),
    );
  });

  it.effect("holds a client turn start until the branch switch on its checkout finishes", () => {
    const log: string[] = [];
    return Effect.gen(function* () {
      const switchGate = yield* Deferred.make<void>();
      const switchEntered = yield* Deferred.make<void>();
      const layer = makeHarness({
        threads: [shellThread("root", null, false)],
        log,
        switchGate,
        switchEntered,
      });
      yield* Effect.gen(function* () {
        const git = yield* GitWorkflow.GitWorkflowService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const switching = yield* git
          .switchRef({ cwd: "/repo", refName: "main" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(switchEntered);
        const dispatching = yield* threads.dispatch(messageDispatch("root")).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(log).toEqual(["switch:start"]);
        yield* Deferred.succeed(switchGate, undefined);
        yield* Fiber.join(switching);
        yield* Fiber.join(dispatching);
        expect(log).toEqual(["switch:start", "switch:end", "dispatch"]);
      }).pipe(Effect.provide(layer));
    });
  });
});
