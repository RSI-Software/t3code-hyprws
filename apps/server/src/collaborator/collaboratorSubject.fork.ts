// Fork-only (colleague-collab): who a collaborator is, apart from the share service so auth can
// read it without importing the service that depends on auth.
import * as Duration from "effect/Duration";

// Persisted in paired sessions, so it keeps the feature's original name.
const COLLABORATOR_SUBJECT_PREFIX = "colleague:";

export const isCollaboratorSubject = (subject: string) =>
  subject.startsWith(COLLABORATOR_SUBJECT_PREFIX);

// Mirrors `guardRpc`'s closed set: socket tickets and one shared thread's reads, whose handlers
// check the share. Every other HTTP API endpoint, upstream's new ones included, refuses.
const COLLABORATOR_HTTP_PATHS = [
  /^\/api\/auth\/websocket-ticket(\/[^/]+)?$/,
  /^\/api\/orchestration\/threads\/[^/]+(\/(transcript|bounded|history))?$/,
];

export const isCollaboratorHttpRefusedFork = (subject: string, url: string) =>
  isCollaboratorSubject(subject) &&
  !COLLABORATOR_HTTP_PATHS.some((path) => path.test(new URL(url, "http://host").pathname));

// Case and punctuation fold on purpose, so "Sam" and "sam " reach the same paired collaborator.
export const collaboratorSubject = (name: string) =>
  `${COLLABORATOR_SUBJECT_PREFIX}${name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")}`;

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
