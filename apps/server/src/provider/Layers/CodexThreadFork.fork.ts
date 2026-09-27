// Fork-only: the lazy half of the same-provider Codex thread fork. The
// `thread.fork` handler captures the source's latest completed turn id at
// click and installs a child binding cursor
// `{ threadId: <parent native id>, forkFrom: { lastTurnId } }`; this module
// reads that cursor back and sends `thread/fork` over the client's raw
// request when the child's session starts — metadata-only decode, same as
// resume. Fails closed: unlike `thread/resume`, a fork error never falls back
// to `thread/start`, so a broken fork cannot silently blank the child.
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

/** Same shape as the runtime's private resume-metadata schema. */
const CodexThreadForkMetadata = Schema.Struct({
  cwd: Schema.String,
  model: Schema.String,
  thread: Schema.Struct({ id: Schema.String }),
});
const decodeCodexThreadForkMetadata = Schema.decodeUnknownEffect(CodexThreadForkMetadata);

/** The fork cursor a child binding carries while its fork has not run yet. */
export interface CodexForkCursor {
  readonly threadId: string;
  readonly forkFrom: { readonly lastTurnId: string };
}

const isCodexForkCursor = (resumeCursor: unknown): resumeCursor is CodexForkCursor => {
  if (!resumeCursor || typeof resumeCursor !== "object") return false;
  const cursor = resumeCursor as {
    readonly threadId?: unknown;
    readonly forkFrom?: unknown;
  };
  if (typeof cursor.threadId !== "string" || cursor.threadId.length === 0) return false;
  const forkFrom = cursor.forkFrom;
  return (
    typeof forkFrom === "object" &&
    forkFrom !== null &&
    typeof (forkFrom as { readonly lastTurnId?: unknown }).lastTurnId === "string" &&
    (forkFrom as { readonly lastTurnId: string }).lastTurnId.length > 0
  );
};

/** The source binding's plain resume cursor: `{ threadId: <native id> }`. */
export const readCodexForkSourceThreadId = (resumeCursor: unknown): string | undefined => {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const threadId = (resumeCursor as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
};

/**
 * The cutoff a cursor already carries: forking a fresh lazy fork reuses the
 * parent cutoff instead of needing a completed turn of its own.
 */
export const readCodexForkCutoffFork = (resumeCursor: unknown): string | undefined =>
  isCodexForkCursor(resumeCursor) ? resumeCursor.forkFrom.lastTurnId : undefined;

/** Fields the runtime's `start` spreads into `openCodexThread`'s input. */
export const codexThreadForkOpenField = (
  resumeCursor: unknown,
): { readonly forkFromLastTurnId: string } | {} => {
  if (!isCodexForkCursor(resumeCursor)) return {};
  return { forkFromLastTurnId: resumeCursor.forkFrom.lastTurnId };
};

/** Structural slice of `openCodexThread`'s input the fork branch needs. */
export interface CodexThreadForkOpenInput {
  readonly threadId: ThreadId;
  readonly forkFromLastTurnId?: string | undefined;
  /** The same raw request channel the resume path uses. */
  readonly client: {
    readonly raw: {
      readonly request: (
        method: "thread/resume",
        payload: CodexRpc.ClientRequestParamsByMethod["thread/resume"] & {
          readonly excludeTurns?: boolean;
        },
      ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
    };
  };
}

/** The start-param fields a fork request can carry (same `| null` optionality). */
type CodexThreadForkStartParams = Pick<
  CodexRpc.ClientRequestParamsByMethod["thread/fork"],
  | "cwd"
  | "approvalPolicy"
  | "sandbox"
  | "approvalsReviewer"
  | "model"
  | "serviceTier"
  | "developerInstructions"
  | "config"
>;

/**
 * Fork the parent thread at `lastTurnId` for the child's first start. Sends
 * `thread/fork` (with `excludeTurns`, like the resume path) over the client's
 * raw request and decodes only the session metadata; every failure mode fails
 * closed.
 */
export const forkCodexThreadOnOpen = (
  input: CodexThreadForkOpenInput,
  parentThreadId: string,
  startParams: CodexThreadForkStartParams,
): Effect.Effect<typeof CodexThreadForkMetadata.Type, CodexErrors.CodexAppServerError> => {
  const { forkFromLastTurnId } = input;
  if (forkFromLastTurnId === undefined) {
    return Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("thread/fork"));
  }
  // Built field-by-field: fork params drop a few start-only fields, and the
  // exact-optional settings forbid spreading possibly-undefined values.
  const payload: CodexRpc.ClientRequestParamsByMethod["thread/fork"] = {
    ...(startParams.cwd !== undefined ? { cwd: startParams.cwd } : {}),
    ...(startParams.approvalPolicy !== undefined
      ? { approvalPolicy: startParams.approvalPolicy }
      : {}),
    ...(startParams.sandbox !== undefined ? { sandbox: startParams.sandbox } : {}),
    ...(startParams.approvalsReviewer !== undefined
      ? { approvalsReviewer: startParams.approvalsReviewer }
      : {}),
    ...(startParams.model !== undefined ? { model: startParams.model } : {}),
    ...(startParams.serviceTier !== undefined ? { serviceTier: startParams.serviceTier } : {}),
    ...(startParams.developerInstructions !== undefined
      ? { developerInstructions: startParams.developerInstructions }
      : {}),
    ...(startParams.config !== undefined ? { config: startParams.config } : {}),
    threadId: parentThreadId,
    lastTurnId: forkFromLastTurnId,
    excludeTurns: true,
  };
  // The raw channel is typed for resume; a fork rides the same method-passthrough.
  return input.client.raw
    .request("thread/fork" as "thread/resume", payload as never)
    .pipe(
      Effect.flatMap((response) =>
        decodeCodexThreadForkMetadata(response).pipe(
          Effect.mapError((error) =>
            CodexErrors.CodexAppServerRequestError.invalidPayload(
              "thread/fork",
              "decode-payload",
              error,
            ),
          ),
        ),
      ),
    );
};
