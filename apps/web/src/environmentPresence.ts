import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The comparison the UI uses to decide whether an environment is "remote" —
 * i.e. somewhere other than the machine this app runs its own backend on.
 */
export interface EnvironmentPresenceScope {
  /** The environment served by the app's own backend, when it has one. */
  readonly primaryEnvironmentId: EnvironmentId | null;
  /**
   * False when this app can never own a local backend (client-only desktop, hosted web), so
   * every environment is remote. Deliberately separate from a null `primaryEnvironmentId`,
   * which a managed app also reports while its backend registers, when nothing is remote yet.
   */
  readonly ownsLocalEnvironment: boolean;
}

export function isRemoteEnvironmentId(
  environmentId: EnvironmentId,
  scope: EnvironmentPresenceScope,
): boolean {
  if (!scope.ownsLocalEnvironment) {
    return true;
  }
  return scope.primaryEnvironmentId !== null && environmentId !== scope.primaryEnvironmentId;
}
