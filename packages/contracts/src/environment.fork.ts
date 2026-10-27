import * as Schema from "effect/Schema";

/**
 * Fork: the stored thread env mode. "worktrunk" is a "worktree" that also runs Worktrunk hooks;
 * it is storage and server-internal only, since a released client drops a whole payload whose
 * mode field is unknown. Upstream's `ThreadEnvMode` stays two-valued for every wire field; the
 * helpers in `@t3tools/shared/threadEnvMode.fork` own both directions.
 */
export const ForkThreadEnvMode = Schema.Literals(["local", "worktree", "worktrunk"]);
export type ForkThreadEnvMode = typeof ForkThreadEnvMode.Type;
