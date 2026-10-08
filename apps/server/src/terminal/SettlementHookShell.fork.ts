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

export const settlementHookTerminalModeFork = (configured: Effect.Effect<TerminalSessionMode>) =>
  Effect.flatMap(SettlementHookShell, (settle) =>
    settle ? Effect.succeed("shell" as const) : configured,
  );
