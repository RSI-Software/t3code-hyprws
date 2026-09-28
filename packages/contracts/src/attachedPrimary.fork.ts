import * as Schema from "effect/Schema";

/**
 * Ownership of the backend behind a desktop bootstrap: the desktop app spawns and stops a
 * `managed` one; `attached` is a running local server adopted as primary without owning its
 * process. Legacy bootstraps omit it and describe managed backends.
 */
export const AttachedPrimaryLifecycleSchema = Schema.Literals(["managed", "attached"]);
export type AttachedPrimaryLifecycle = typeof AttachedPrimaryLifecycleSchema.Type;

/**
 * Why the renderer rejects an attached bearer: `transport` (the request never
 * got an answer) or `unauthorized` (a 401 that survived one re-mint).
 */
export const AttachedPrimaryRejectReasonSchema = Schema.Literals(["transport", "unauthorized"]);
export type AttachedPrimaryRejectReason = typeof AttachedPrimaryRejectReasonSchema.Type;
