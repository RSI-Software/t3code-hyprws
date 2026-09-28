import type { AuthSessionState } from "@t3tools/contracts";

import { isDesktopClientOnlyMode } from "~/environments/primary/target";

/**
 * The scopes Connections settings gate their rows on. A desktop app that owns
 * its backend holds `ownedScopes`; a client-only launch attaches a server it
 * does not manage and holds only what that session was granted, so the
 * exposure, Tailscale, and update rows stay hidden
 * (RSI-Software/t3code-hyprws#1390).
 */
export function connectionsSessionScopesFork<Owned extends ReadonlyArray<string>>(
  desktopBridge: unknown,
  ownedScopes: Owned,
  session: AuthSessionState | null,
  clientOnly: boolean = isDesktopClientOnlyMode(),
): Owned | NonNullable<AuthSessionState["scopes"]> | null {
  if (desktopBridge && !clientOnly) return ownedScopes;
  return session?.authenticated ? (session.scopes ?? null) : null;
}
