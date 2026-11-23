// Fork-only (colleague-collab): who a collaborator is, apart from the share service so auth can
// read it without importing the service that depends on auth.
import * as Duration from "effect/Duration";

// Persisted in paired sessions, so it keeps the feature's original name.
export const COLLABORATOR_SUBJECT_PREFIX = "colleague:";

export const isCollaboratorSubject = (subject: string) =>
  subject.startsWith(COLLABORATOR_SUBJECT_PREFIX);

/** A collaborator keeps access until the host unshares or revokes; the store needs some expiry. */
const COLLABORATOR_SESSION_TTL = Duration.days(36_500);

/** A collaborator's session lifetime, as the `ttl` or the DPoP `renewalWindow` field; else none. */
export const collaboratorSessionLifetimeFork = (
  subject: string,
  field: "ttl" | "renewalWindow" = "ttl",
) =>
  !isCollaboratorSubject(subject)
    ? {}
    : field === "ttl"
      ? { ttl: COLLABORATOR_SESSION_TTL }
      : { renewalWindow: COLLABORATOR_SESSION_TTL };
