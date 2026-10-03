import * as Schema from "effect/Schema";

import type { EnvironmentResourceNotFoundReason } from "./environmentHttp.ts";

/**
 * Fork: the not-found reasons only fork endpoints answer with. Upstream's
 * `EnvironmentResourceNotFoundReason` stays its own declaration;
 * `EnvironmentResourceNotFoundError` decodes the union of both.
 */
export const ForkResourceNotFoundReason = Schema.Literals(["agent_not_found", "project_not_found"]);

/** Fork: every not-found reason a fork server may answer with. */
export type ForkEnvironmentResourceNotFoundReason =
  | EnvironmentResourceNotFoundReason
  | typeof ForkResourceNotFoundReason.Type;
