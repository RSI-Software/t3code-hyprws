// Fork-only: the thread checkout move (zmux-estate) rides on the upstream
// `thread.metadata.update` command and the `AppThread` payload. The decider and
// the shell projection reach this module through marked hooks, so upstream
// keeps one metadata command and one thread payload.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  ThreadCheckoutMove,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
  thread: Pick<OrchestrationV2AppThread, "updatedAt">,
): { checkoutMove?: ThreadCheckoutMove; updatedAt?: OrchestrationV2AppThread["updatedAt"] } => {
  if (command.type !== "thread.metadata.update" || command.checkoutMove === undefined) return {};
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

const hasLiveRun = <E>(readRuns: RunRecords<E>) =>
  readRuns.pipe(
    Effect.map(({ runs }) =>
      runs.some(
        (run) =>
          run.status === "preparing" ||
          run.status === "starting" ||
          run.status === "running" ||
          run.status === "waiting",
      ),
    ),
  );

/**
 * Refuses a committed checkout move while the thread has a live run. The move
 * service checks idleness before it commits, but a run from a starter outside
 * the client lease can begin in between, and the committed write would detach
 * that run's provider sessions. The service requeues a refused move. Recovery
 * of a removed worktree is the exception: the turn-start gate commits it for
 * the run it is starting.
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
