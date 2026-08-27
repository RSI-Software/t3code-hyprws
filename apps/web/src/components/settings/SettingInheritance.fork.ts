import type { ServerSettings } from "@t3tools/contracts";
import { fromWireThreadEnvModeFields } from "@t3tools/shared/threadEnvMode.fork";

interface SettingInheritanceTarget {
  readonly settings: ServerSettings;
}

/**
 * Display-only copies with the exact stored fork mode restored. These copies
 * never reach the wire, whose settings type intentionally accepts only upstream modes.
 */
export function displaySettingInheritanceInputs<T extends SettingInheritanceTarget>(
  target: T,
  environmentSettings: ServerSettings,
): { readonly target: T; readonly environmentSettings: ServerSettings } {
  const displayTarget = {
    ...target,
    settings: {
      ...target.settings,
      defaultThreadEnvMode: fromWireThreadEnvModeFields(target.settings),
    },
  };
  const displayEnvironmentSettings = {
    ...environmentSettings,
    defaultThreadEnvMode: fromWireThreadEnvModeFields(environmentSettings),
  };
  return {
    target: displayTarget as unknown as T,
    environmentSettings: displayEnvironmentSettings as unknown as ServerSettings,
  };
}
