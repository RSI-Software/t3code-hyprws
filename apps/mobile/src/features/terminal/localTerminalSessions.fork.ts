import { boundedTerminalAttachmentId } from "@t3tools/client-runtime/state/checkout-move";
import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { useMemo, useSyncExternalStore } from "react";

import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";

const EMPTY: ReadonlyArray<KnownTerminalSession> = [];
let deviceId: string | null = null;
let loading = false;
const listeners = new Set<() => void>();

// One device id per install; a failed load retries on the next subscriber.
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (deviceId === null && !loading) {
    loading = true;
    void loadOrCreateAgentAwarenessDeviceId()
      .then((id) => {
        deviceId = id;
        for (const notify of listeners) notify();
      })
      .catch(() => undefined)
      .finally(() => {
        loading = false;
      });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Sessions this device attached; other devices' attachments never pick or describe this route's terminal. */
export function useLocalKnownSessionsFork(
  sessions: ReadonlyArray<KnownTerminalSession> | null,
): ReadonlyArray<KnownTerminalSession> {
  const id = useSyncExternalStore(subscribe, () => deviceId);
  return useMemo(
    () =>
      id === null || sessions === null
        ? EMPTY
        : sessions.filter(
            (session) =>
              session.target.attachmentId ===
              boundedTerminalAttachmentId(id, session.target.terminalId),
          ),
    [id, sessions],
  );
}
