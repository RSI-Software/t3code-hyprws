// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  defaultInstanceIdForDriver,
  type CheckoutPhysicalIdentity,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "../../../integration/OrchestrationEngineHarness.integration.ts";

const PROJECT_ID = ProjectId.make("checkout-move-project");
const THREAD_ID = ThreadId.make("checkout-move-thread");
const OTHER_THREAD_ID = ThreadId.make("checkout-move-other-thread");
const PROVIDER = ProviderDriverKind.make("codex");
const INSTANCE_ID = defaultInstanceIdForDriver(PROVIDER);
const MODEL_SELECTION = { instanceId: INSTANCE_ID, model: DEFAULT_MODEL };
const NOW = "2026-09-05T00:00:00.000Z";

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function checkoutIdentity(cwd: string): CheckoutPhysicalIdentity {
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return {
    repositoryRoot:
      NodePath.basename(commonDir) === ".git" ? NodePath.dirname(commonDir) : commonDir,
    checkoutRoot: git(cwd, ["rev-parse", "--show-toplevel"]),
    revision: git(cwd, ["rev-parse", "HEAD"]),
    branch: git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  };
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E, Scope.Scope>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThreads = (
  harness: OrchestrationIntegrationHarness,
  source: CheckoutPhysicalIdentity,
  includeOther = false,
) =>
  Effect.gen(function* () {
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("checkout-move-project-create"),
      projectId: PROJECT_ID,
      title: "Checkout move project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: MODEL_SELECTION,
      createdAt: NOW,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("checkout-move-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Checkout move thread",
      modelSelection: MODEL_SELECTION,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: source.branch,
      worktreePath: null,
      createdAt: NOW,
    });
    if (includeOther) {
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("checkout-move-other-thread-create"),
        threadId: OTHER_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Other thread",
        modelSelection: MODEL_SELECTION,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: source.branch,
        worktreePath: null,
        createdAt: NOW,
      });
    }
  });

function makeDestination(harness: OrchestrationIntegrationHarness): CheckoutPhysicalIdentity {
  const destination = NodePath.join(harness.rootDir, "destination");
  git(harness.workspaceDir, ["worktree", "add", "-b", "checkout-move-destination", destination]);
  return checkoutIdentity(destination);
}

const prepareMove = (
  harness: OrchestrationIntegrationHarness,
  source: CheckoutPhysicalIdentity,
  destination: CheckoutPhysicalIdentity,
) =>
  harness.engine.dispatch({
    type: "thread.checkout-move.prepare",
    commandId: CommandId.make("checkout-move-prepare"),
    requestId: CommandId.make("checkout-move-request"),
    threadId: THREAD_ID,
    source,
    sourceThreadBranch: source.branch,
    sourceThreadWorktreePath: null,
    destination,
    queued: false,
    createdAt: "2026-09-05T00:00:01.000Z",
  });

describe("checkout move provider reactor", () => {
  it.live("moves metadata without spawning a dormant provider", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const source = checkoutIdentity(harness.workspaceDir);
        const destination = makeDestination(harness);
        yield* seedProjectAndThreads(harness, source);

        assert.equal((yield* harness.providerService.listSessions()).length, 0);
        yield* prepareMove(harness, source, destination);
        yield* harness.drainProviderCommand;

        const thread = yield* harness.snapshotQuery.getThreadShellById(THREAD_ID);
        assert(Option.isSome(thread));
        assert.equal(thread.value.worktreePath, destination.checkoutRoot);
        assert.deepEqual(thread.value.checkoutMove?.completedSteps, ["metadata"]);
        assert.equal(thread.value.checkoutMove?.providerAvailable, false);
        assert.equal(thread.value.checkoutMove?.effectiveProvider, null);
        assert.equal((yield* harness.providerService.listSessions()).length, 0);
      }),
    ),
  );

  it.live("relocates an existing provider and records its effective checkout", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const source = checkoutIdentity(harness.workspaceDir);
        const destination = makeDestination(harness);
        yield* seedProjectAndThreads(harness, source);
        const session = yield* harness.providerService.startSession(THREAD_ID, {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          provider: PROVIDER,
          providerInstanceId: INSTANCE_ID,
          cwd: source.checkoutRoot,
          modelSelection: MODEL_SELECTION,
          runtimeMode: "approval-required",
        });
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("checkout-move-session-set"),
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: session.provider,
            providerInstanceId: ProviderInstanceId.make(session.providerInstanceId ?? INSTANCE_ID),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: session.updatedAt,
          },
          createdAt: session.updatedAt,
        });

        yield* prepareMove(harness, source, destination);
        yield* harness.drainProviderCommand;

        const runtime = (yield* harness.providerService.listSessions()).find(
          (candidate) => candidate.threadId === THREAD_ID,
        );
        assert.equal(runtime?.cwd, destination.checkoutRoot);
        const thread = yield* harness.snapshotQuery.getThreadShellById(THREAD_ID);
        assert(Option.isSome(thread));
        assert.deepEqual(thread.value.checkoutMove?.completedSteps, ["provider", "metadata"]);
        assert.equal(thread.value.checkoutMove?.providerAvailable, true);
        assert.deepEqual(thread.value.checkoutMove?.effectiveProvider, destination);
      }),
    ),
  );

  it.live("keeps unrelated provider commands moving while a checkout lease is blocked", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const source = checkoutIdentity(harness.workspaceDir);
        const destination = makeDestination(harness);
        yield* seedProjectAndThreads(harness, source, true);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* harness.checkoutMutationCoordinator
          .withLease(
            source.checkoutRoot,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* prepareMove(harness, source, destination);

        const events = yield* harness.engine.subscribeDomainEvents;
        const otherSessionSet = yield* events.pipe(
          Stream.filter(
            (event) =>
              event.type === "thread.session-set" && event.payload.threadId === OTHER_THREAD_ID,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("checkout-move-other-turn"),
          threadId: OTHER_THREAD_ID,
          message: {
            messageId: MessageId.make("checkout-move-other-message"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: "2026-09-05T00:00:02.000Z",
        });
        assert(Option.isSome(yield* Fiber.join(otherSessionSet)));

        const blocked = yield* harness.snapshotQuery.getThreadShellById(THREAD_ID);
        assert(Option.isSome(blocked));
        assert.equal(blocked.value.checkoutMove?.status, "preparing");
        yield* Deferred.succeed(release, undefined);
        yield* harness.drainProviderCommand;
      }),
    ),
  );

  it.live("refuses a move while another active thread owns either checkout", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const source = checkoutIdentity(harness.workspaceDir);
        const destination = makeDestination(harness);
        yield* seedProjectAndThreads(harness, source, true);
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("checkout-move-other-active-session"),
          threadId: OTHER_THREAD_ID,
          session: {
            threadId: OTHER_THREAD_ID,
            status: "running",
            providerName: PROVIDER,
            providerInstanceId: INSTANCE_ID,
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("checkout-move-other-active-turn"),
            lastError: null,
            updatedAt: "2026-09-05T00:00:02.000Z",
          },
          createdAt: "2026-09-05T00:00:02.000Z",
        });

        yield* prepareMove(harness, source, destination);
        yield* harness.drainProviderCommand;

        const refused = yield* harness.snapshotQuery.getThreadShellById(THREAD_ID);
        assert(Option.isSome(refused));
        assert.equal(refused.value.checkoutMove?.status, "failed");
        assert.match(refused.value.checkoutMove?.detail ?? "", /active on thread/);
        assert.equal(refused.value.worktreePath, null);
      }),
    ),
  );

  describe("worktree checkout recovery", () => {
    const GONE_BRANCH = "checkout-recovery-gone";
    const RECOVERY_THREAD_ID = ThreadId.make("checkout-recovery-thread");

    const seedStrandedThread = (harness: OrchestrationIntegrationHarness) =>
      Effect.gen(function* () {
        const root = checkoutIdentity(harness.workspaceDir);
        yield* seedProjectAndThreads(harness, root, true);
        const worktreePath = NodePath.join(harness.rootDir, "gone-worktree");
        git(harness.workspaceDir, ["worktree", "add", "-b", GONE_BRANCH, worktreePath]);
        const deadPath = checkoutIdentity(worktreePath).checkoutRoot;
        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("checkout-recovery-thread-create"),
          threadId: RECOVERY_THREAD_ID,
          projectId: PROJECT_ID,
          title: "Stranded thread",
          modelSelection: MODEL_SELECTION,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: GONE_BRANCH,
          worktreePath: deadPath,
          createdAt: NOW,
        });
        return { root, deadPath };
      });

    const strand = (harness: OrchestrationIntegrationHarness, deadPath: string) => {
      git(harness.workspaceDir, ["worktree", "remove", "--force", deadPath]);
      git(harness.workspaceDir, ["branch", "-D", GONE_BRANCH]);
    };

    // Stamped with the wall clock recovery reads, so the queued-turn guard the
    // inline move bypasses is live rather than expired.
    const startTurn = (harness: OrchestrationIntegrationHarness, attempt = "") =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`checkout-recovery-turn${attempt}`),
            threadId: RECOVERY_THREAD_ID,
            message: {
              messageId: MessageId.make(`checkout-recovery-message${attempt}`),
              role: "user",
              text: "continue",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: DateTime.formatIso(now),
          }),
        ),
        Effect.andThen(harness.drainProviderCommand),
      );

    const setOtherSession = (
      harness: OrchestrationIntegrationHarness,
      activeTurnId: TurnId | null,
      at: string,
    ) =>
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`checkout-recovery-other-session-${at}`),
        threadId: OTHER_THREAD_ID,
        session: {
          threadId: OTHER_THREAD_ID,
          status: activeTurnId === null ? "ready" : "running",
          providerName: PROVIDER,
          providerInstanceId: INSTANCE_ID,
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      });

    const assertRecovered = (
      harness: OrchestrationIntegrationHarness,
      root: CheckoutPhysicalIdentity,
    ) =>
      Effect.gen(function* () {
        const thread = yield* harness.snapshotQuery.getThreadShellById(RECOVERY_THREAD_ID);
        assert(Option.isSome(thread));
        assert.equal(thread.value.worktreePath, null);
        assert.equal(thread.value.branch, root.branch);
        assert.equal(thread.value.checkoutMove?.status, "committed");
        assert.equal(thread.value.checkoutMove?.reason, "worktree-recovery");
      });

    const recoveryActivities = (harness: OrchestrationIntegrationHarness) =>
      harness.snapshotQuery
        .getThreadDetailById(RECOVERY_THREAD_ID)
        .pipe(Effect.map((thread) => Option.getOrThrow(thread).activities));

    it.live("moves a thread whose worktree and branch are gone to the project root", () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { root, deadPath } = yield* seedStrandedThread(harness);
          const session = yield* harness.providerService.startSession(RECOVERY_THREAD_ID, {
            threadId: RECOVERY_THREAD_ID,
            projectId: PROJECT_ID,
            provider: PROVIDER,
            providerInstanceId: INSTANCE_ID,
            cwd: deadPath,
            modelSelection: MODEL_SELECTION,
            runtimeMode: "approval-required",
          });
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("checkout-recovery-session-set"),
            threadId: RECOVERY_THREAD_ID,
            session: {
              threadId: RECOVERY_THREAD_ID,
              status: "ready",
              providerName: session.provider,
              providerInstanceId: ProviderInstanceId.make(
                session.providerInstanceId ?? INSTANCE_ID,
              ),
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: session.updatedAt,
            },
            createdAt: session.updatedAt,
          });
          strand(harness, deadPath);
          // The move restarts the warm session at the root; the turn lands there.
          yield* harness.adapterHarness!.queueTurnResponseForNextSession({ events: [] });

          yield* startTurn(harness);

          const thread = yield* harness.snapshotQuery.getThreadShellById(RECOVERY_THREAD_ID);
          assert(Option.isSome(thread));
          assert.equal(thread.value.worktreePath, null);
          assert.equal(thread.value.branch, root.branch);
          assert.equal(thread.value.checkoutMove?.status, "committed");
          const runtime = (yield* harness.providerService.listSessions()).find(
            (candidate) => candidate.threadId === RECOVERY_THREAD_ID,
          );
          assert.equal(runtime?.cwd, root.checkoutRoot);
          const activities = yield* recoveryActivities(harness);
          const recovery = activities.find(
            (activity) => activity.kind === "worktree.checkout-recovery",
          );
          assert.equal(
            recovery?.summary,
            `Worktree ${deadPath} no longer exists; moved this thread to ${root.checkoutRoot} on ${root.branch}`,
          );
          assert.isFalse(
            activities.some((activity) => activity.kind === "provider.turn.start.failed"),
          );
        }),
      ),
    );

    it.live("stops the turn when another thread owns the project root", () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { deadPath } = yield* seedStrandedThread(harness);
          yield* harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("checkout-recovery-other-active-session"),
            threadId: OTHER_THREAD_ID,
            session: {
              threadId: OTHER_THREAD_ID,
              status: "running",
              providerName: PROVIDER,
              providerInstanceId: INSTANCE_ID,
              runtimeMode: "approval-required",
              activeTurnId: TurnId.make("checkout-recovery-other-active-turn"),
              lastError: null,
              updatedAt: "2026-09-05T00:00:02.000Z",
            },
            createdAt: "2026-09-05T00:00:02.000Z",
          });
          strand(harness, deadPath);

          yield* startTurn(harness);

          const thread = yield* harness.snapshotQuery.getThreadShellById(RECOVERY_THREAD_ID);
          assert(Option.isSome(thread));
          assert.equal(thread.value.worktreePath, deadPath);
          assert.equal(thread.value.checkoutMove?.status, "failed");
          assert.match(thread.value.checkoutMove?.detail ?? "", /active on thread/);
          const activities = yield* recoveryActivities(harness);
          assert.isTrue(
            activities.some((activity) => activity.kind === "provider.turn.start.failed"),
          );
          assert.isFalse(
            activities.some((activity) => activity.kind === "worktree.checkout-recovery"),
          );
        }),
      ),
    );

    it.live("recovers on a resend once the owning thread settles", () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { root, deadPath } = yield* seedStrandedThread(harness);
          yield* setOtherSession(
            harness,
            TurnId.make("checkout-recovery-other-active-turn"),
            "2026-09-05T00:00:02.000Z",
          );
          strand(harness, deadPath);
          yield* startTurn(harness);
          const blocked = yield* harness.snapshotQuery.getThreadShellById(RECOVERY_THREAD_ID);
          assert.equal(Option.getOrThrow(blocked).checkoutMove?.status, "failed");

          yield* setOtherSession(harness, null, "2026-09-05T00:00:04.000Z");
          yield* harness.adapterHarness!.queueTurnResponseForNextSession({ events: [] });
          yield* startTurn(harness, "-resend");

          yield* assertRecovered(harness, root);
        }),
      ),
    );

    it.live("recovers while another stranded thread is running", () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const { root, deadPath } = yield* seedStrandedThread(harness);
          const otherPath = NodePath.join(harness.rootDir, "other-gone-worktree");
          git(harness.workspaceDir, ["worktree", "add", "-b", "other-gone", otherPath]);
          yield* harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("checkout-recovery-other-worktree"),
            threadId: OTHER_THREAD_ID,
            branch: "other-gone",
            worktreePath: checkoutIdentity(otherPath).checkoutRoot,
          });
          yield* setOtherSession(
            harness,
            TurnId.make("checkout-recovery-other-active-turn"),
            "2026-09-05T00:00:02.000Z",
          );
          git(harness.workspaceDir, ["worktree", "remove", "--force", otherPath]);
          strand(harness, deadPath);
          yield* harness.adapterHarness!.queueTurnResponseForNextSession({ events: [] });

          yield* startTurn(harness);

          yield* assertRecovered(harness, root);
        }),
      ),
    );
  });
});
