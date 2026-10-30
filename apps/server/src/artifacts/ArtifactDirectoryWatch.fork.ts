// @effect-diagnostics nodeBuiltinImport:off - fs.watch fails synchronously on a missing directory, so its links read missing at once.
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";

/** Watches a linked artifact's parent directory; tests swap in a fake watcher. */
export const ArtifactDirectoryWatch = Context.Reference<typeof NodeFS.watch>(
  "t3/artifacts/ArtifactDirectoryWatch.fork",
  { defaultValue: () => NodeFS.watch },
);

export type ArtifactDirectoryWatcher = NodeFS.FSWatcher;
