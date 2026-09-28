import type { RunningLocalServer } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { connectPairing } from "./onboarding";
import { useAtomCommand } from "../state/use-atom-command";
import { isDesktopClientOnlyMode } from "../environments/primary/target";
import { useEnvironments } from "../state/environments";

/**
 * Once per launch, and only while the saved environment list is empty: a user who
 * removes the environment on purpose is not re-paired behind their back. A managed
 * launch spawned its own server and owns a same-origin credential, so it never pairs.
 */
export function shouldAttemptDesktopAutoPair(input: {
  readonly attempted: boolean;
  readonly isReady: boolean;
  readonly environmentCount: number;
  readonly isClientOnly: boolean;
}): boolean {
  return !input.attempted && input.isReady && input.environmentCount === 0 && input.isClientOnly;
}

/**
 * The attached server is the only one this window can reach without the user
 * naming a host, so a machine running several servers falls through to
 * Connections rather than guessing which one the user meant.
 */
export function selectDesktopAutoPairTarget(
  servers: readonly RunningLocalServer[],
): RunningLocalServer | null {
  return servers.length === 1 ? (servers[0] ?? null) : null;
}

/**
 * Client-only desktop attaches to a server it did not spawn, so a fresh profile has
 * no same-origin primary or saved credential. The main process mints a pairing link
 * through the bundled `t3 pair` command, so the app pairs itself instead of asking
 * the user to paste one for a server on the same machine.
 */
export function DesktopLocalAutoPair() {
  const { environments, isReady } = useEnvironments();
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const attemptedRef = useRef(false);

  // oxlint-disable-next-line t3code/react-effect-budget -- discovers and pairs the local server over desktop IPC once environments load.
  useEffect(() => {
    if (window.desktopBridge?.refreshAttachedPrimaryBootstrap) return; // fork-hook: backend-attach/auto-pair-retired
    if (
      !shouldAttemptDesktopAutoPair({
        attempted: attemptedRef.current,
        isReady,
        environmentCount: environments.length,
        isClientOnly: isDesktopClientOnlyMode(),
      })
    ) {
      return;
    }

    const bridge = window.desktopBridge;
    const discover = bridge?.discoverLocalServers;
    const pairLocalServer = bridge?.pairLocalServer;
    if (!discover || !pairLocalServer) return;

    attemptedRef.current = true;
    void (async () => {
      const servers = await discover().catch(() => []);
      const server = selectDesktopAutoPairTarget(servers);
      if (!server) return;
      const { pairingUrl } = await pairLocalServer(server.environmentId);
      await pair({ pairingUrl });
    })().catch(() => {
      // Pairing is a convenience over the manual Connections flow; a failure
      // leaves the user exactly where they would have been without it.
    });
  }, [environments.length, isReady, pair]);

  return null;
}
