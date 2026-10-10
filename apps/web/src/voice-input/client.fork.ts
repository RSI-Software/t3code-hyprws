import { isVoiceTextHttpErrorFork } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { AsyncResult } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export async function runVoiceInputRequestFork<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal?: AbortSignal,
  failureMessage = "Dictation request failed. Check the endpoint, API key, and environment permissions.",
) {
  const result = await executeAtomQuery(appAtomRegistry, connectionAtomRuntime.atom(effect), {
    ...(signal ? { signal } : {}),
    reportFailure: false,
    reportDefect: false,
  });
  if (AsyncResult.isSuccess(result)) return result.value;
  if (AsyncResult.isFailure(result)) {
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    if (isVoiceTextHttpErrorFork(error)) throw error;
  }
  throw new Error(failureMessage);
}

export const VOICE_SETTINGS_CHANGED_FORK = "fork-voice-input-settings-changed";
