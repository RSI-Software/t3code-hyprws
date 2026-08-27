import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripForeignHarnessIdentityEnv, stripInheritedTmuxEnv } from "@t3tools/shared/env";

// The returned environment is complete. Provider spawners must pass it as-is
// rather than extending process.env, which would reintroduce the scrubbed keys.
// `ownDriverKind` keeps the target provider's own harness identity while every
// other provider's markers are dropped, so tooling inside the thread cannot
// attribute the work to the harness that launched the app.
export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  ownDriverKind: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = stripForeignHarnessIdentityEnv(stripInheritedTmuxEnv(baseEnv), ownDriverKind);
  if (!environment || environment.length === 0) {
    return next;
  }

  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}
