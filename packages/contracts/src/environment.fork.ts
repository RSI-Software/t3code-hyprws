import * as Schema from "effect/Schema";

/**
 * Fork: the stored thread env mode. "worktrunk" is a "worktree" that also runs
 * the repository's Worktrunk hooks; it is the storage and server-internal form
 * only. Nothing that crosses the wire may carry it, because a released client
 * validates a mode field against the two-value wire schema and drops the whole
 * payload on an unknown value.
 *
 * This lives beside — not inside — upstream's `environment.ts`, whose
 * `ThreadEnvMode` stays exactly the two upstream values and keeps decoding
 * every wire field. The helpers in `@t3tools/shared/threadEnvMode.fork` own
 * both directions.
 */
export const ForkThreadEnvMode = Schema.Literals(["local", "worktree", "worktrunk"]);
export type ForkThreadEnvMode = typeof ForkThreadEnvMode.Type;
