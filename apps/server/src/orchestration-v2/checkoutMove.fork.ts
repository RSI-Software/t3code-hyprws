// Fork-only: the thread checkout move (zmux-estate) rides on the upstream
// `thread.metadata.update` command and the `AppThread` payload. The decider and
// the shell projection reach this module through marked hooks, so upstream
// keeps one metadata command and one thread payload.
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type ThreadCheckoutMove,
  TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { CheckpointServiceV2Shape } from "./CheckpointService.ts";
import type { RuntimePolicyV2Shape } from "./RuntimePolicy.ts";

type MetadataUpdate = Extract<OrchestrationV2ServerCommand, { type: "thread.metadata.update" }>;

/** Fields a metadata update changes besides the checkout move itself. */
const OTHER_METADATA_FIELDS = [
  "title",
  "regenerateTitle",
  "branch",
  "worktreePath",
  "limitRecovery",
  "linkedPullRequest",
] as const satisfies ReadonlyArray<keyof MetadataUpdate>;

/**
 * The decider's merge for a metadata update carrying a checkout move. A
 * progress-only update (queued, preparing, failed) keeps `updatedAt`, so a
 * move's bookkeeping never reads as fresh thread activity.
 */
export const checkoutMoveMetadataFork = (
  command: OrchestrationV2ServerCommand,
  thread: Pick<OrchestrationV2AppThread, "updatedAt" | "worktreePath">,
): {
  checkoutMove?: ThreadCheckoutMove | undefined;
  updatedAt?: OrchestrationV2AppThread["updatedAt"];
} => {
  if (command.type !== "thread.metadata.update") return {};
  if (command.checkoutMove === undefined) {
    // A handoff outside the move service supersedes its old recovery/Undo
    // record. Title edits and same-checkout updates keep that record intact.
    return command.worktreePath !== undefined && command.worktreePath !== thread.worktreePath
      ? { checkoutMove: undefined }
      : {};
  }
  const progressOnly = OTHER_METADATA_FIELDS.every((field) => command[field] === undefined);
  return progressOnly
    ? { checkoutMove: command.checkoutMove, updatedAt: thread.updatedAt }
    : { checkoutMove: command.checkoutMove };
};

/** Carries the thread's checkout move onto its shell. */
export const checkoutMoveShellFieldsFork = (
  thread: Pick<OrchestrationV2AppThread, "checkoutMove">,
): { checkoutMove?: ThreadCheckoutMove } =>
  thread.checkoutMove === undefined ? {} : { checkoutMove: thread.checkoutMove };

const committedCheckoutMove = (command: OrchestrationV2ServerCommand) =>
  command.type === "thread.metadata.update" && command.checkoutMove?.status === "committed"
    ? command.checkoutMove
    : undefined;

type RunRecords<E> = Effect.Effect<
  { readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">> },
  E
>;

const isLiveRun = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

const hasLiveRun = <E>(readRuns: RunRecords<E>) =>
  readRuns.pipe(Effect.map(({ runs }) => runs.some(isLiveRun)));

/**
 * Refuses a committed checkout move while the thread has a live run: a run from a starter
 * outside the client lease can begin after the service's idle check, and the write would detach
 * its provider sessions. The service requeues a refused move. Removed-worktree recovery is
 * exempt: the turn-start gate commits it for the run it is starting.
 */
export const refuseCheckoutMoveDuringRunFork = <E, E2>(
  command: OrchestrationV2ServerCommand,
  readRuns: RunRecords<E>,
  refuse: (cause: string) => E2,
): Effect.Effect<void, E | E2> => {
  const move = committedCheckoutMove(command);
  if (move === undefined || move.reason === "worktree-recovery") return Effect.void;
  return hasLiveRun(readRuns).pipe(
    Effect.flatMap((live) =>
      live
        ? Effect.fail(refuse("A run started on this thread before its checkout move committed."))
        : Effect.void,
    ),
  );
};
/**
 * Drops the decider's queued workspace-change session detach when its caller
 * detaches inline. A removed-worktree recovery committed for a starting run
 * detaches before that run opens its session; the queued detach effect would
 * run after the turn start and tear the new session down.
 */
export const detachesCheckoutRecoveryInlineFork = <E, A>(
  command: OrchestrationV2ServerCommand,
  readRuns: RunRecords<E>,
  effects: Ref.Ref<Array<A>>,
  pendingEffect: A,
): Effect.Effect<void, E> =>
  committedCheckoutMove(command)?.reason !== "worktree-recovery"
    ? Effect.void
    : hasLiveRun(readRuns).pipe(
        Effect.flatMap((live) =>
          live
            ? Ref.update(effects, (existing) =>
                existing.filter((effect) => effect !== pendingEffect),
              )
            : Effect.void,
        ),
      );

type CheckpointScopeCreated = Extract<
  OrchestrationV2DomainEvent,
  { type: "checkpoint-scope.created" }
>;
type TurnItemUpdated = Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>;

/**
 * Records a committed removed-worktree recovery. The timeline notice is keyed by the move's
 * request id, so a replay rewrites it, and joins the live or latest run, since a paged client
 * drops run-less items. The re-emitted checkpoint scope replaces the stale one, which names the
 * removed worktree where no baseline can be captured, before the turn start reads it.
 */
export const recordCheckoutRecoveryFork = Effect.fn("recordCheckoutRecoveryFork")(function <
  E,
  E2,
>(input: {
  readonly command: OrchestrationV2ServerCommand;
  readonly thread: OrchestrationV2AppThread;
  readonly readRuns: Effect.Effect<{ readonly runs: ReadonlyArray<OrchestrationV2Run> }, E>;
  readonly runtimePolicy: RuntimePolicyV2Shape;
  readonly checkpointService: CheckpointServiceV2Shape;
  readonly emit: <Event extends CheckpointScopeCreated | TurnItemUpdated>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<unknown, E2>;
  readonly now: DateTime.Utc;
}) {
  const { thread, now } = input;
  const move = committedCheckoutMove(input.command);
  if (move?.reason !== "worktree-recovery") return Effect.void;
  const rescope = ({
    id,
    rootNodeId,
    providerThreadId,
    providerInstanceId,
    modelSelection,
  }: OrchestrationV2Run) =>
    rootNodeId === null || providerThreadId === null
      ? Effect.void
      : input.runtimePolicy.resolve({ thread, modelSelection }).pipe(
          Effect.flatMap((policy) =>
            input.checkpointService.prepareRootRunScope({
              threadId: thread.id,
              runId: id,
              rootNodeId,
              providerThreadId,
              cwd: policy.cwd ?? thread.worktreePath ?? process.cwd(),
              createdAt: now,
            }),
          ),
          Effect.flatMap((scope) =>
            input.emit<CheckpointScopeCreated>({
              type: "checkpoint-scope.created",
              threadId: thread.id,
              runId: id,
              nodeId: rootNodeId,
              providerInstanceId,
              occurredAt: now,
              payload: scope,
            }),
          ),
        );
  const destination = move.destination;
  const notice = (runs: ReadonlyArray<OrchestrationV2Run>) => {
    const byOrdinal = runs.toSorted((left, right) => left.ordinal - right.ordinal);
    const run = byOrdinal.findLast(isLiveRun) ?? byOrdinal.at(-1);
    return input.emit<TurnItemUpdated>({
      type: "turn-item.updated",
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`fork:worktree-recovery:${move.requestId}`),
        threadId: thread.id,
        runId: run?.id ?? null,
        nodeId: run?.rootNodeId ?? null,
        providerThreadId: run?.providerThreadId ?? null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // The event sink assigns the real position on write.
        ordinal: 0,
        status: "completed",
        title: "Worktree recovery",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "system_notice",
        message: `Worktree ${move.sourceThreadWorktreePath ?? move.expectedCheckoutRoot} no longer exists; moved this thread to ${destination?.checkoutRoot ?? move.requestedPath} on ${destination?.branch ?? "a detached HEAD"}`,
      },
    });
  };
  return input.readRuns.pipe(
    Effect.tap(({ runs }) => notice(runs)),
    Effect.flatMap(({ runs }) =>
      Effect.forEach(
        runs.filter((run) => run.status === "starting"),
        rescope,
        { discard: true },
      ),
    ),
  );
});
