import type { AuthSessionState } from "@t3tools/contracts";

import { isDesktopClientOnlyMode } from "~/environments/primary/target";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";

/**
 * The scopes Connections settings delegate from. A desktop app that owns its
 * backend holds `ownedScopes`; a client-only launch attaches a server it does
 * not manage and holds only what that session was granted
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

/**
 * Whether this client may manage the local backend: its version, network
 * access, Tailscale, and WSL rows. Upstream gates them on the maintain scope,
 * which a standard pairing grants, so a client-only launch must also opt out:
 * the server it attached belongs to someone else (RSI-Software/t3code-hyprws#1773).
 */
export function canManageLocalBackendFork(
  canMaintain: boolean,
  clientOnly: boolean = isDesktopClientOnlyMode(),
  localEnvironmentDisabled: boolean = isLocalEnvironmentDisabled(),
): boolean {
  return canMaintain && !clientOnly && !localEnvironmentDisabled;
}
