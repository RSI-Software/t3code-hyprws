// Fork-owned send guards (RSI-Software/t3code-hyprws device-auth domain) for a
// caller that vetted a thread before sending to it. `steerTarget` on
// `ThreadManagementService.sendToThread` names the one provider attempt the
// message may join: `auto` queues instead of joining another, and `steer` or
// `restart` fails. `expectedModes` names the thread modes the caller vetted.
// Both ride on `message.dispatch`, and the orchestrator refuses the send under
// the thread lock once the run has moved to another attempt or the modes have
// changed. The guard holds at dispatch commit; modes the owner sets afterwards
// govern turns that resolve their runtime policy later, as for any message.
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2Run,
  RunAttemptId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type DispatchMode = MessageDispatch["dispatchMode"];

export type ExpectedModesFork = NonNullable<MessageDispatch["expectedModes"]>;

const targetAttempt = (runs: ReadonlyArray<OrchestrationV2Run>, dispatchMode: DispatchMode) =>
  dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active"
    ? (runs.find((run) => run.id === dispatchMode.targetRunId)?.activeAttemptId ?? null)
    : undefined;

/** Narrows the dispatch `sendToThread` chose to the attempt its caller vetted. */
export const pinSteerTargetFork = <E>(
  input: { readonly mode: string; readonly steerTarget?: RunAttemptId | null },
  runs: ReadonlyArray<OrchestrationV2Run>,
  dispatchMode: DispatchMode,
  refuse: (mode: "steer" | "restart") => E,
): Effect.Effect<DispatchMode, E> => {
  const attempt = targetAttempt(runs, dispatchMode);
  if (input.steerTarget === undefined || attempt === undefined || attempt === input.steerTarget) {
    return Effect.succeed(dispatchMode);
  }
  return input.mode === "steer" || input.mode === "restart"
    ? Effect.fail(refuse(input.mode))
    : Effect.succeed({ type: "queue_after_active" });
};

/** The `message.dispatch` fields that carry a send's guards to the orchestrator. */
export const sendGuardFieldsFork = (input: {
  readonly steerTarget?: RunAttemptId | null;
  readonly expectedModes?: ExpectedModesFork;
}) => ({
  ...(input.steerTarget == null ? {} : { steerAttemptId: input.steerTarget }),
  ...(input.expectedModes === undefined ? {} : { expectedModes: input.expectedModes }),
});

/** Refuses a guarded send once the thread modes or its pinned attempt changed. */
export const refuseStaleExternalSendFork = <E>(
  command: Pick<MessageDispatch, "steerAttemptId" | "expectedModes">,
  projection: {
    readonly thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
  },
  dispatchMode: DispatchMode,
  refuse: (cause: string) => E,
): Effect.Effect<void, E> => {
  const modes = command.expectedModes;
  if (
    modes !== undefined &&
    (modes.runtimeMode !== projection.thread.runtimeMode ||
      modes.interactionMode !== projection.thread.interactionMode)
  ) {
    return Effect.fail(refuse("The thread's modes changed after this send was vetted."));
  }
  const attempt = targetAttempt(projection.runs, dispatchMode);
  return command.steerAttemptId === undefined ||
    attempt === undefined ||
    attempt === command.steerAttemptId
    ? Effect.void
    : Effect.fail(
        refuse(`Attempt ${command.steerAttemptId} is no longer the target run's attempt.`),
      );
};
