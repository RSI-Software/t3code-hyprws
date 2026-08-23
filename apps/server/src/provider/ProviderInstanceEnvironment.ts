import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripInheritedTmuxEnv } from "@t3tools/shared/env";

// The returned environment is complete. Provider spawners must pass it as-is
// rather than extending process.env, which would reintroduce the scrubbed keys.
export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = stripInheritedTmuxEnv(baseEnv);
  if (!environment || environment.length === 0) {
    return next;
  }

  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}
