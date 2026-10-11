// Fork-only (zmux-estate): settle scripts must survive removal of their checkout's
// managed session, including when cleanup finishes before the hook terminal opens.
import type { TerminalSessionMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

class SettlementHookShell extends Context.Reference<boolean>(
  "t3/terminal/SettlementHookShell.fork/SettlementHookShell",
  { defaultValue: () => false },
) {}

export const inSettlementHookShellFork = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  settle: boolean,
) => Effect.provideService(effect, SettlementHookShell, settle);

/** A terminal's chosen mode wins over the default; settle hooks still force a shell. */
export const terminalModeForSessionFork = (
  chosen: TerminalSessionMode | null,
  configured: Effect.Effect<TerminalSessionMode>,
) =>
  Effect.flatMap(SettlementHookShell, (settle) =>
    settle
      ? Effect.succeed("shell" as const)
      : chosen === null
        ? configured
        : Effect.succeed(chosen),
  );
