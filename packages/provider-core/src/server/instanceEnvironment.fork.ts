import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { stripForeignHarnessIdentityEnv, stripInheritedTmuxEnv } from "@t3tools/shared/env";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

/** Provider spawners pass this complete environment without extending process.env again. */
export function mergeForkProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  ownDriverKind?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return mergeProviderInstanceEnvironment(
    environment,
    stripForeignHarnessIdentityEnv(stripInheritedTmuxEnv(baseEnv), ownDriverKind),
  );
}
