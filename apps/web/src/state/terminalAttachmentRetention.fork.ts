import {
  EMPTY_TERMINAL_SESSION_STATE,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, TerminalAttachInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachedTerminalSessionAtom as liveTerminalSessionAtom } from "./terminalSessions";

/**
 * A version-0 session is a new stream's seed, reported until its first snapshot after a re-show
 * or checkout move. Accepting it would replay a phantom "closed" over the kept buffer and close
 * the drawer; an attach failure still shows over the kept buffer.
 */
export function retainTerminalSession(
  retained: TerminalSessionState | null,
  live: TerminalSessionState,
): TerminalSessionState {
  if (retained === null || retained.version === 0 || live.version > 0) return live;
  return live.error === null ? retained : { ...retained, status: live.status, error: live.error };
}

// Reads the live session only while a surface demands it: a hidden surface releases the attach,
// so the server suspends a managed zmux attachment, and keeps showing its last session.
export const retainedTerminalSessionFork = Atom.family((live: Atom.Atom<TerminalSessionState>) => {
  const demanded = Atom.make(false);
  return Atom.writable(
    (get): TerminalSessionState => {
      const retained = Option.getOrNull(get.self<TerminalSessionState>());
      if (!get(demanded)) return retained ?? EMPTY_TERMINAL_SESSION_STATE;
      return retainTerminalSession(retained, get(live));
    },
    (ctx, attached: boolean) => ctx.set(demanded, attached),
  );
});

export function attachedTerminalSessionAtom(
  environmentId: EnvironmentId | null,
  terminal: TerminalAttachInput | null,
) {
  return retainedTerminalSessionFork(liveTerminalSessionAtom(environmentId, terminal));
}

export function useTerminalAttachDemandFork(
  session: Atom.Writable<TerminalSessionState, boolean>,
  attached: boolean,
): void {
  // Mounted here so the demand outlives the write whichever registry the caller mounts in.
  // oxlint-disable-next-line t3code/react-effect-budget -- syncs the prop into the shared registry
  useEffect(() => {
    const release = appAtomRegistry.mount(session);
    appAtomRegistry.set(session, attached);
    return release;
  }, [session, attached]);
}
