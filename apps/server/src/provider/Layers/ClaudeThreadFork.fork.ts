// Fork-only: eager same-provider fork of a Claude session, run at click time
// by the `thread.fork` handler. `forkSession` clones the full native
// conversation (native forks rewrite every UUID), so the child's resume cursor
// is seeded from the CLONE's own human-prompt UUIDs: upstream rollback matches
// those boundaries against the clone, and real UUIDs (never nulls) keep the
// inherited turns intact when the first child turn is rewound.
import {
  ClaudeSettings,
  ProviderDriverKind,
  ThreadForkError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeScopedClaudeHistoryCommand,
  resolveClaudeHistoryWorkerArguments,
} from "./ClaudeHistoryCommand.fork.ts";

const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const decodeClaudeSettingsFork = Schema.decodeEffect(ClaudeSettings);

const decodeClaudeHistoryFork = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);

const ClaudeForkHistoryMessage = Schema.Struct({
  type: Schema.String,
  uuid: Schema.String,
  parent_tool_use_id: Schema.NullOr(Schema.String),
  message: Schema.Unknown,
});
const decodeClaudeHistoryMessages = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(ClaudeForkHistoryMessage)),
);
type ClaudeForkHistoryMessage = typeof ClaudeForkHistoryMessage.Type;

/** The cursor the child binding carries; `resume` is the cloned native session. */
export interface ClaudeForkCursor {
  readonly threadId: ThreadId;
  readonly resume: string;
  readonly turnCount: number;
  readonly turnStartMessageIds: ReadonlyArray<string>;
}

/** Human prompts begin a turn; tool results are user-role messages too. */
export const isClaudeHumanTurnStartFork = (message: ClaudeForkHistoryMessage): boolean => {
  if (message.type !== "user" || message.parent_tool_use_id !== null) return false;
  const body = message.message;
  if (typeof body !== "object" || body === null || !("content" in body)) return false;
  const content = (body as { readonly content: unknown }).content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type !== "tool_result",
      ))
  );
};

/**
 * Turn boundaries of a cloned history, in conversation order: one real UUID
 * per human prompt. Non-null boundaries are the rewind baseline — upstream
 * rollback cuts at `boundaries.length - numTurns` and needs each retained id
 * to exist in the clone.
 */
export const claudeForkTurnBoundaries = (
  messages: ReadonlyArray<ClaudeForkHistoryMessage>,
): ReadonlyArray<string> =>
  messages.filter(isClaudeHumanTurnStartFork).map((message) => message.uuid);

/** The source binding's resume id must be a native Claude session UUID. */
export const readClaudeForkSourceSessionId = (resumeCursor: unknown): string | undefined => {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const resume = (resumeCursor as { readonly resume?: unknown }).resume;
  return typeof resume === "string" && CLAUDE_SESSION_ID_PATTERN.test(resume) ? resume : undefined;
};

const forkHistoryError = (threadId: ThreadId, cause: unknown) =>
  new ThreadForkError({
    threadId,
    reason: "native-fork-failed",
    provider: CLAUDE_DRIVER,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Resolve the isolated environment (carrying this instance's
 * `CLAUDE_CONFIG_DIR`) the scoped history worker must run in. The instance is
 * resolved through `deriveProviderInstanceConfigMap` — the same resolver the
 * registry and the terminal manager use — so built-in default instances
 * (absent from `settings.providerInstances`, mirrored from the legacy
 * `providers.<kind>` blob) resolve exactly like the live adapter's.
 */
export const resolveClaudeForkInstanceEnvironment = Effect.fn(
  "resolveClaudeForkInstanceEnvironment",
)(function* (threadId: ThreadId, instanceId: ProviderInstanceId) {
  const settings = yield* ServerSettingsService;
  const envelope = yield* Effect.mapError(settings.getSettings, (cause) =>
    forkHistoryError(threadId, cause),
  ).pipe(Effect.map((value) => deriveProviderInstanceConfigMap(value)[instanceId]));
  if (envelope === undefined || envelope.driver !== CLAUDE_DRIVER) {
    return yield* forkHistoryError(
      threadId,
      `Provider instance '${instanceId}' is not an available Claude instance.`,
    );
  }
  const config = yield* decodeClaudeSettingsFork(envelope.config ?? {}).pipe(
    Effect.mapError(() =>
      forkHistoryError(
        threadId,
        `Provider instance '${instanceId}' has unreadable Claude settings.`,
      ),
    ),
  );
  const processEnv = mergeProviderInstanceEnvironment(envelope.environment, CLAUDE_DRIVER);
  return yield* makeClaudeEnvironment(config, processEnv);
});

/** Eager native fork: clone the source session, then read the clone back. */
export const forkClaudeSession = Effect.fn("forkClaudeSession")(function* (input: {
  readonly threadId: ThreadId;
  readonly sourceSessionId: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const workerArguments = yield* resolveClaudeHistoryWorkerArguments().pipe(
    Effect.mapError((cause) => forkHistoryError(input.threadId, cause)),
  );
  const run = makeScopedClaudeHistoryCommand({
    workerArguments,
    environment: input.environment,
    spawner,
    fallbackSessionId: input.sourceSessionId,
  });
  const readHistory = (sessionId: string) =>
    Effect.tryPromise({
      try: async () =>
        decodeClaudeHistoryMessages(
          await run(
            "getSessionMessages",
            { dir: input.cwd, includeSystemMessages: true },
            sessionId,
          ),
        ),
      catch: (cause): ThreadForkError => forkHistoryError(input.threadId, cause),
    });

  const forked = yield* Effect.tryPromise({
    try: async () => decodeClaudeHistoryFork(await run("forkSession", { dir: input.cwd })),
    catch: (cause): ThreadForkError => forkHistoryError(input.threadId, cause),
  });
  const cloneMessages = yield* readHistory(forked.sessionId);
  const boundaries = claudeForkTurnBoundaries(cloneMessages);
  if (boundaries.length === 0) {
    return yield* forkHistoryError(
      input.threadId,
      "The cloned Claude session has no human turns to fork.",
    );
  }
  return {
    threadId: input.threadId,
    resume: forked.sessionId,
    turnCount: boundaries.length,
    turnStartMessageIds: boundaries,
  };
});
