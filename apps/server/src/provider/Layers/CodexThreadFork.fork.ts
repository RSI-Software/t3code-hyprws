// Fork-only: the lazy half of the same-provider Codex thread fork. The
// `thread.fork` handler captures the source's latest completed turn id at
// click and installs a child binding cursor
// `{ threadId: <parent native id>, forkFrom: { lastTurnId } }`; this module
// reads that cursor back and sends `thread/fork` when the child's session
// starts. Fails closed: unlike `thread/resume`, a fork error never falls back
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

/** One fork-capable request call; the live client's generic `request` satisfies it. */
export type CodexThreadForkOpenRequest = <M extends "thread/fork">(
  method: M,
  payload: CodexRpc.ClientRequestParamsByMethod[M],
) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;

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

/** Fields the runtime's `start` spreads into `openCodexThread`'s input. */
export const codexThreadForkOpenField = (
  resumeCursor: unknown,
  forkRequest: CodexThreadForkOpenRequest,
):
  | { readonly forkFromLastTurnId: string; readonly forkRequest: CodexThreadForkOpenRequest }
  | {} => {
  if (!isCodexForkCursor(resumeCursor)) return {};
  const lastTurnId = resumeCursor.forkFrom.lastTurnId;
  return { forkFromLastTurnId: lastTurnId, forkRequest };
};

/** Structural slice of `openCodexThread`'s input the fork branch needs. */
export interface CodexThreadForkOpenInput {
  readonly threadId: ThreadId;
  readonly forkFromLastTurnId?: string | undefined;
  readonly forkRequest?: CodexThreadForkOpenRequest | undefined;
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
 * `thread/fork` (with `excludeTurns`, like the resume path) and decodes only
 * the session metadata; every failure mode fails closed.
 */
export const forkCodexThreadOnOpen = (
  input: CodexThreadForkOpenInput,
  parentThreadId: string,
  startParams: CodexThreadForkStartParams,
): Effect.Effect<typeof CodexThreadForkMetadata.Type, CodexErrors.CodexAppServerError> => {
  const { forkRequest, forkFromLastTurnId } = input;
  if (forkRequest === undefined || forkFromLastTurnId === undefined) {
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
  return forkRequest("thread/fork", payload).pipe(
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
