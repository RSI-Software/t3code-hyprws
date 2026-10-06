// Fork-owned retry ledger for `/api/mcp/external` mutations
// (RSI-Software/t3code-hyprws device-auth domain). A `clientRequestId` names
// one request: the ledger binds it to the request's fingerprint, to the target
// it commits to before acting, and once the mutation succeeds to its result, so
// a retry replays that result without touching the thread again, and a reused
// key with a different request fails.
import * as NodeCrypto from "node:crypto";

import { type AuthSessionId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type ExternalMcpOperation = "create" | "send" | "interrupt" | "settle";

/** The target an attempt committed to before it dispatched, read back by a retry. */
export interface ExternalMcpPin {
  readonly recorded: string | null;
  readonly record: (target: string) => Effect.Effect<void, OrchestratorMcpFailure>;
}

/** A stable digest of the fields that define a request, in a fixed order. */
export const requestFingerprint = (fields: ReadonlyArray<readonly [string, unknown]>) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(fields.filter(([, value]) => value !== undefined)))
    .digest("hex");

const storeFailure = (error: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `External MCP request ledger unavailable: ${error instanceof Error ? error.message : String(error)}`,
  });

export const makeExternalMcpRequestLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One external mutation at a time, so two in-flight copies of a request
  // never both reach the thread before either records its result.
  const lock = yield* Semaphore.make(1);

  /**
   * Runs `execute` once per `(session, operation, key)`. A retry with the same
   * fingerprint replays the stored result; a different fingerprint fails. A
   * request whose earlier attempt never recorded a result runs again, so
   * `execute` must recover what that attempt already committed, through its
   * stable ids or its pin, before it selects anything from the live thread.
   */
  const run = <A, I>(
    input: {
      readonly sessionId: AuthSessionId;
      readonly operation: ExternalMcpOperation;
      readonly clientRequestId: string;
      readonly fingerprint: string;
      readonly result: Schema.Codec<A, I>;
    },
    execute: (pin: ExternalMcpPin) => Effect.Effect<A, OrchestratorMcpFailure>,
  ): Effect.Effect<A, OrchestratorMcpFailure> => {
    const codec = Schema.fromJsonString(input.result);
    return Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO auth_external_mcp_requests
          (session_id, operation, client_request_id, request_hash, result_json, created_at)
        VALUES
          (${input.sessionId}, ${input.operation}, ${input.clientRequestId}, ${input.fingerprint}, NULL, ${createdAt})
        ON CONFLICT (session_id, operation, client_request_id) DO NOTHING
      `.pipe(Effect.mapError(storeFailure));
      const [row] = yield* sql<{
        readonly requestHash: string;
        readonly pinnedTarget: string | null;
        readonly resultJson: string | null;
      }>`
        SELECT request_hash AS "requestHash", pinned_target AS "pinnedTarget",
          result_json AS "resultJson"
        FROM auth_external_mcp_requests
        WHERE session_id = ${input.sessionId}
          AND operation = ${input.operation}
          AND client_request_id = ${input.clientRequestId}
      `.pipe(Effect.mapError(storeFailure));
      if (row === undefined) return yield* storeFailure("the claimed request row is missing");
      if (row.requestHash !== input.fingerprint) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `clientRequestId ${input.clientRequestId} already names a different ${input.operation} request; use a new key.`,
        });
      }
      if (row.resultJson !== null) {
        return yield* Schema.decodeEffect(codec)(row.resultJson).pipe(
          Effect.mapError(storeFailure),
        );
      }
      const result = yield* execute({
        recorded: row.pinnedTarget,
        record: (target) =>
          sql`
            UPDATE auth_external_mcp_requests
            SET pinned_target = ${target}
            WHERE session_id = ${input.sessionId}
              AND operation = ${input.operation}
              AND client_request_id = ${input.clientRequestId}
          `.pipe(Effect.asVoid, Effect.mapError(storeFailure)),
      });
      const resultJson = yield* Schema.encodeEffect(codec)(result).pipe(
        Effect.mapError(storeFailure),
      );
      yield* sql`
        UPDATE auth_external_mcp_requests
        SET result_json = ${resultJson}
        WHERE session_id = ${input.sessionId}
          AND operation = ${input.operation}
          AND client_request_id = ${input.clientRequestId}
      `.pipe(Effect.mapError(storeFailure));
      return result;
    }).pipe(lock.withPermits(1));
  };

  return { run };
});
