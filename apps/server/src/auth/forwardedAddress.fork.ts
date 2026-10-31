// Fork-only (colleague-collab): behind a local tunnel or proxy every peer is loopback, so a
// session would record 127.0.0.1. Only a loopback peer is trusted to name the real client.
import * as NodeNet from "node:net";

import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

/** The forwarded client address to record over the peer's, or nothing. */
export const forwardedClientAddressFork = (
  peer: string | undefined,
  headers: Readonly<Record<string, string | undefined>>,
): { readonly ipAddress?: string } => {
  if (peer === undefined || !isLocalLoopbackHost(peer)) return {};
  const forwarded = (
    headers["cf-connecting-ip"] ?? headers["x-forwarded-for"]?.split(",")[0]
  )?.trim();
  return forwarded !== undefined && NodeNet.isIP(forwarded) !== 0 ? { ipAddress: forwarded } : {};
};
