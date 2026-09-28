import * as Schema from "effect/Schema";

/**
 * Ownership of the backend behind a desktop bootstrap
 * (RSI-Software/t3code-hyprws#1350): `managed` is spawned and stopped by the
 * desktop app; `attached` is a running local server the desktop adopted as
 * its primary without owning its process. Legacy bootstraps omit it and
 * describe managed backends.
 */
export const AttachedPrimaryLifecycleSchema = Schema.Literals(["managed", "attached"]);
export type AttachedPrimaryLifecycle = typeof AttachedPrimaryLifecycleSchema.Type;

/**
 * Why the renderer rejects an attached bearer: `transport` (the request never
 * got an answer) or `unauthorized` (a 401 that survived one re-mint).
 */
export const AttachedPrimaryRejectReasonSchema = Schema.Literals(["transport", "unauthorized"]);
export type AttachedPrimaryRejectReason = typeof AttachedPrimaryRejectReasonSchema.Type;
