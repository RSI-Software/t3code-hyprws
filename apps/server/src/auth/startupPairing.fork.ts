import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * `T3CODE_NO_STARTUP_PAIRING=1` skips the startup pairing link, minting no credential:
 * a hosted server's stdout is its log, and anyone who reads that log could pair as admin.
 * An env var, not a flag, so a server older than this ignores it instead of refusing to start.
 */
export const skipStartupPairingFork = Config.Boolean("T3CODE_NO_STARTUP_PAIRING").pipe(
  Config.withDefault(false),
  Effect.tap((skip) =>
    skip ? Effect.logInfo("Startup pairing link skipped; run `t3 pair` to mint one.") : Effect.void,
  ),
);
