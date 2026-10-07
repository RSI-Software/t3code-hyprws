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
): Owned | NonNullable<AuthSessionState["permissions"]> | null {
  if (desktopBridge && !clientOnly) return ownedScopes;
  // Permissions are the current wire field; scopes remain for servers older than them.
  return session?.authenticated ? (session.permissions ?? session.scopes ?? null) : null;
}
