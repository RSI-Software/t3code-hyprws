// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

// The one reader for the `ghb attest handoff` envelope: the bot-owned host identity the walk
// attestation carries (RSI-Software/t3code-hyprws#703). Every caller — the sync walk's agent
// provenance and the churn ledger's row effort — parses the same envelope through this module,
// so a schema move is a one-file change.

import { requireCommandSuccess, runCommand } from "./fork-command.ts";

export interface HostHandoff {
  readonly iface: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly session: string;
}

const IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const requirePart = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || !IDENTITY_PART.test(value))
    throw new Error(`invalid ${field}`);
  return value;
};

/** Parse the `ghb.host-handoff.v1` envelope into the host identity it attests. */
export const parseHostHandoff = (raw: string): HostHandoff => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error("host handoff received invalid ghb handoff JSON");
  }
  if (typeof envelope !== "object" || envelope === null)
    throw new Error("host handoff received invalid ghb handoff");
  const { schema, host } = envelope as Record<string, unknown>;
  if (schema !== "ghb.host-handoff.v1")
    throw new Error("host handoff received unsupported ghb handoff schema");
  if (typeof host !== "object" || host === null)
    throw new Error("host handoff has no host identity");
  const identity = host as Record<string, unknown>;
  if (identity.role !== "host") throw new Error("host handoff has invalid host role");
  return {
    iface: requirePart(identity.iface, "host handoff interface"),
    provider: requirePart(identity.provider, "host handoff provider"),
    model: requirePart(identity.model, "host handoff model"),
    effort: requirePart(identity.effort, "host handoff effort"),
    session: requirePart(identity.session, "host handoff session"),
  };
};

/** The live host handoff, as the `ghb` CLI attests it for this session. */
export const readHostHandoff = (cwd: string): HostHandoff =>
  parseHostHandoff(
    requireCommandSuccess(runCommand("ghb", ["attest", "handoff"], { cwd }), "ghb", [
      "attest",
      "handoff",
    ]),
  );
