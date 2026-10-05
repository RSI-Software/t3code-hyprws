// @effect-diagnostics nodeBuiltinImport:off - Keep the launcher independent of Effect.
import * as NodeAsyncHooks from "node:async_hooks";

import type { PendingServiceUpdate } from "./cloud/serviceProtocol.ts";

// Carries the stop signal into the backup copy without widening upstream signatures.
const backupAbort = new NodeAsyncHooks.AsyncLocalStorage<AbortSignal>();

export const backupAbortSignalFork = (): AbortSignal | undefined => backupAbort.getStore();

/** A stop kills `cp` and skips the rename; the launcher keeps the update pending to resume. */
export const abortableBackupFork =
  (
    signal: AbortSignal,
    backup: (baseDir: string, pending: PendingServiceUpdate) => Promise<void>,
  ) =>
  (baseDir: string, pending: PendingServiceUpdate): Promise<void> =>
    backupAbort.run(signal, () => backup(baseDir, pending));
