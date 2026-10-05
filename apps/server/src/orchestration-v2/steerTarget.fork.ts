// Fork-owned steer pin (RSI-Software/t3code-hyprws device-auth domain). A
// caller that vetted one provider attempt sets `steerTarget` on
// `ThreadManagementService.sendToThread`, so its message never joins another
// attempt: not a later run, and not a restart of the same run. `auto` queues
// instead and `steer` or `restart` fails. The pin rides on `message.dispatch`
// as `steerAttemptId`, and the orchestrator refuses it under the thread lock
// once the run has moved to another attempt.
import type { OrchestrationV2Command, OrchestrationV2Run, RunAttemptId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type DispatchMode = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

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

/** The `message.dispatch` field that carries a send's pin to the orchestrator. */
export const steerAttemptFieldFork = (input: { readonly steerTarget?: RunAttemptId | null }) =>
  input.steerTarget == null ? {} : { steerAttemptId: input.steerTarget };

/** Refuses a pinned steer once its run has moved to another attempt. */
export const refuseStaleSteerAttemptFork = <E>(
  command: { readonly steerAttemptId?: RunAttemptId | undefined },
  runs: ReadonlyArray<OrchestrationV2Run>,
  dispatchMode: DispatchMode,
  refuse: (cause: string) => E,
): Effect.Effect<void, E> => {
  const attempt = targetAttempt(runs, dispatchMode);
  return command.steerAttemptId === undefined ||
    attempt === undefined ||
    attempt === command.steerAttemptId
    ? Effect.void
    : Effect.fail(
        refuse(`Attempt ${command.steerAttemptId} is no longer the target run's attempt.`),
      );
};
