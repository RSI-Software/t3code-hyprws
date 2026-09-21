// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// The one reader for agent identity in fork tooling (RSI-Software/t3code-hyprws#703, updated by
// RSI-Software/t3code-hyprws#1112). A review sign-off wants the *live caller's own* identity, so a
// peer-spawned reviewer records itself and never the session that proposed the walk. It comes
// from `ghb attest caller`, which a worker may emit: it always carries `caller`, and carries
// `host` as well once the caller is holding a handed-off envelope.

import { requireCommandSuccess, runCommand } from "./fork-command.ts";

export interface AgentIdentity {
  readonly role: string;
  readonly iface: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly session: string;
}

export interface CallerAttestation {
  /** Whoever ran the command, host or worker. */
  readonly caller: AgentIdentity;
  /** The host behind a handed-off worker; absent when the caller is itself the host. */
  readonly host: AgentIdentity | null;
}

const IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const requirePart = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || !IDENTITY_PART.test(value))
    throw new Error(`invalid ${field}`);
  return value;
};

const requireIdentity = (value: unknown, field: string): AgentIdentity => {
  if (typeof value !== "object" || value === null) throw new Error(`${field} has no identity`);
  const identity = value as Record<string, unknown>;
  return {
    role: requirePart(identity.role, `${field} role`),
    iface: requirePart(identity.iface, `${field} interface`),
    provider: requirePart(identity.provider, `${field} provider`),
    model: requirePart(identity.model, `${field} model`),
    effort: requirePart(identity.effort, `${field} effort`),
    session: requirePart(identity.session, `${field} session`),
  };
};

/** Parse the `ghb.caller.v1` envelope into the identities it attests. */
export const parseCallerAttestation = (raw: string): CallerAttestation => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error("caller attestation received invalid ghb caller JSON");
  }
  if (typeof envelope !== "object" || envelope === null)
    throw new Error("caller attestation received invalid ghb caller");
  const { schema, caller, host } = envelope as Record<string, unknown>;
  if (schema !== "ghb.caller.v1")
    throw new Error("caller attestation received unsupported ghb caller schema");
  const resolved = requireIdentity(caller, "caller attestation");
  if (host === undefined || host === null) {
    if (resolved.role !== "host")
      throw new Error("caller attestation names no host and the caller is not one");
    return { caller: resolved, host: null };
  }
  const attestedHost = requireIdentity(host, "caller attestation host");
  if (attestedHost.role !== "host") throw new Error("caller attestation has invalid host role");
  return { caller: resolved, host: attestedHost };
};

const readCallerAttestation = (cwd: string): CallerAttestation =>
  parseCallerAttestation(
    requireCommandSuccess(runCommand("ghb", ["attest", "caller"], { cwd }), "ghb", [
      "attest",
      "caller",
    ]),
  );

/**
 * This session's own identity, never a host's. A review sign-off wants this one: substituting the
 * host would record the proposing session as the reviewer, which
 * `docs/fork/operations/fork-sync.md` forbids.
 */
export const readCallerIdentity = (cwd: string): AgentIdentity => readCallerAttestation(cwd).caller;
