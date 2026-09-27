// Fork-only: the scoped Claude history-worker spawn path used by the thread
// fork handler (`ClaudeThreadFork.fork.ts`); mirrors `runScopedHistoryCommand`
// in `ClaudeAdapter.ts`. SDK history helpers read process.env, so the worker
// runs in the provider instance's isolated environment instead of mutating the
// server's, and the single-executable hosts the worker as its
// `__claude-history` subcommand.
import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

/** 30s bounds one worker invocation; a stuck CLI must not hang the RPC. */
const HISTORY_COMMAND_TIMEOUT = "30 seconds";

/** The service shape the tag yields; mirrors what `ChildProcessSpawner.make` builds. */
type ChildProcessSpawnerService = ReturnType<typeof ChildProcessSpawner.make>;

/**
 * Resolve the history worker invocation. The single-executable has no sibling
 * script and no Node to run one with, so it hosts the worker as a hidden
 * subcommand of itself. Paths resolve relative to this file, which sits beside
 * `ClaudeAdapter.ts` and therefore reaches the same
 * `claude-history-worker` entry in both the dev tree and the bundle.
 */
export const resolveClaudeHistoryWorkerArguments = Effect.fn("resolveClaudeHistoryWorkerArguments")(
  function* () {
    return (yield* HostProcessIsExecutable)
      ? ["__claude-history"]
      : [
          yield* Path.Path.pipe(
            Effect.flatMap((path) =>
              path.fromFileUrl(
                new URL(
                  import.meta.url.endsWith(".ts")
                    ? "../../claude-history-worker.ts"
                    : "./claude-history-worker.mjs",
                  import.meta.url,
                ),
              ),
            ),
          ),
        ];
  },
);

export interface ScopedClaudeHistoryCommand {
  (
    method: "getSessionMessages" | "forkSession",
    args: object,
    historySessionId?: string,
  ): Promise<string>;
}

/**
 * Build the scoped history-command runner. `environment` must already carry
 * the provider instance's `CLAUDE_CONFIG_DIR`; the spawn passes it as-is so
 * the SDK helpers read the right home without the server changing its own
 * environment while other providers are running.
 */
export const makeScopedClaudeHistoryCommand = (input: {
  readonly workerArguments: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawnerService;
  /** Default session id, matching the rollback closure's third-argument default. */
  readonly fallbackSessionId: string;
}): ScopedClaudeHistoryCommand => {
  const { workerArguments, environment, spawner, fallbackSessionId } = input;
  return async (method, args, historySessionId = fallbackSessionId) => {
    const result = await Effect.runPromise(
      spawnAndCollect(
        process.execPath,
        ChildProcess.make(
          process.execPath,
          [...workerArguments, method, historySessionId, JSON.stringify(args)],
          { env: { ...environment, ELECTRON_RUN_AS_NODE: "1" } },
        ),
      ).pipe(
        Effect.timeout(HISTORY_COMMAND_TIMEOUT),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    );
    if (result.code !== 0) throw new Error(result.stderr || "Claude history command failed.");
    return result.stdout;
  };
};
