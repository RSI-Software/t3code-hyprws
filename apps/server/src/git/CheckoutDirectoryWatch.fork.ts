// @effect-diagnostics nodeBuiltinImport:off - fs.watch exposes the synchronous acquisition receipt required before checkout mutations can be observed safely.
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";

/** Watches a checkout's git directory for HEAD changes; tests swap in a failing watcher. */
export const CheckoutDirectoryWatch = Context.Reference<typeof NodeFS.watch>(
  "t3/orchestration/CheckpointReactor/checkoutDirectoryWatch",
  { defaultValue: () => NodeFS.watch },
);
