import { readVoiceInputSettingsFork, readVoiceTextSettingsFork } from "@t3tools/client-runtime/rpc";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import * as Option from "effect/Option";
import { usePreparedConnection, useEnvironmentScope } from "../state/session";
import { runVoiceInputRequestFork, VOICE_SETTINGS_CHANGED_FORK } from "./client.fork";

function useVoiceSettingsQueryFork<A, E>(
  environmentId: EnvironmentId | null,
  read: (
    prepared: Parameters<typeof readVoiceTextSettingsFork>[0],
  ) => Parameters<typeof runVoiceInputRequestFork<A, E>>[0],
  failureMessage: string,
) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const [result, setResult] = useState<{
    environmentId: EnvironmentId;
    settings: A;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!prepared || !canRead) return;
    let active = true;
    let request: AbortController | null = null;
    const load = () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      void runVoiceInputRequestFork(read(prepared), current.signal, failureMessage).then(
        (settings) => {
          if (active && !current.signal.aborted) {
            setResult({ environmentId: prepared.environmentId, settings });
            setError(null);
          }
        },
        () => {
          if (active && !current.signal.aborted) setError(failureMessage);
        },
      );
    };
    load();
    window.addEventListener(VOICE_SETTINGS_CHANGED_FORK, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      request?.abort();
      window.removeEventListener(VOICE_SETTINGS_CHANGED_FORK, load);
      window.removeEventListener("focus", load);
    };
  }, [prepared, canRead, read, failureMessage]);
  return { settings: result?.environmentId === environmentId ? result.settings : null, error };
}

export const useVoiceSettingsFork = (environmentId: EnvironmentId | null) =>
  useVoiceSettingsQueryFork(
    environmentId,
    readVoiceInputSettingsFork,
    "Could not load dictation settings.",
  );

export const useVoiceTextSettingsFork = (environmentId: EnvironmentId | null) =>
  useVoiceSettingsQueryFork(
    environmentId,
    readVoiceTextSettingsFork,
    "Could not load text processing settings.",
  );
