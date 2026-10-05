import { AuthSessionId, ProjectId, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What an owner-approved external MCP client may do at `/api/mcp/external`.
 *
 * The device grant that carries a policy issues a session with no environment
 * scopes, so the token reaches no RPC or HTTP route; this policy, keyed by the
 * session, is its only authority. Revoking or expiring the session ends it.
 */
export const ExternalMcpPolicy = Schema.Struct({
  /** `"*"` is every project in the environment, including ones added later. */
  projectIds: Schema.Union([Schema.Literal("*"), Schema.Array(ProjectId)]),
  /** Create, send to, and interrupt threads; reads need no flag. */
  coordinate: Schema.Boolean,
  /** The highest runtime mode a thread the client creates or drives may run in. */
  maxRuntimeMode: RuntimeMode,
  maxInteractionMode: ProviderInteractionMode,
});
export type ExternalMcpPolicy = typeof ExternalMcpPolicy.Type;

const PolicyJson = Schema.fromJsonString(ExternalMcpPolicy);
export const encodeExternalMcpPolicy = Schema.encodeSync(PolicyJson);
export const decodeExternalMcpPolicy = Schema.decodeUnknownSync(PolicyJson);

export const externalMcpPolicyAllowsProject = (policy: ExternalMcpPolicy, projectId: ProjectId) =>
  policy.projectIds === "*" || policy.projectIds.includes(projectId);

export interface ExternalMcpGrant {
  readonly policy: ExternalMcpPolicy;
  /** The label the client presented when it started the device grant. */
  readonly clientLabel: string | null;
}

export class ExternalMcpGrantStoreError extends Data.TaggedError("ExternalMcpGrantStoreError")<{
  readonly cause: unknown;
}> {}

export class ExternalMcpGrantStore extends Context.Service<
  ExternalMcpGrantStore,
  {
    readonly getBySession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<ExternalMcpGrant>, ExternalMcpGrantStoreError>;
  }
>()("t3/auth/ExternalMcpGrant.fork/ExternalMcpGrantStore") {}

/** Records the policy for a just-issued session, inside the caller's transaction. */
export const recordExternalMcpGrant = (input: {
  readonly sessionId: AuthSessionId;
  readonly policy: ExternalMcpPolicy;
  readonly clientLabel: string | null;
  readonly createdAt: string;
}) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`
        INSERT INTO auth_external_mcp_grants (session_id, policy_json, client_label, created_at)
        VALUES (
          ${input.sessionId},
          ${encodeExternalMcpPolicy(input.policy)},
          ${input.clientLabel},
          ${input.createdAt}
        )
      `,
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ExternalMcpGrantStore.of({
    getBySession: (sessionId) =>
      sql<{ readonly policyJson: string; readonly clientLabel: string | null }>`
        SELECT policy_json AS "policyJson", client_label AS "clientLabel"
        FROM auth_external_mcp_grants
        WHERE session_id = ${sessionId}
      `.pipe(
        Effect.flatMap(([row]) =>
          row === undefined
            ? Effect.succeed(Option.none<ExternalMcpGrant>())
            : Effect.try(() =>
                Option.some({
                  policy: decodeExternalMcpPolicy(row.policyJson),
                  clientLabel: row.clientLabel,
                }),
              ),
        ),
        Effect.mapError((cause) => new ExternalMcpGrantStoreError({ cause })),
        Effect.withSpan("ExternalMcpGrantStore.getBySession"),
      ),
  });
});

export const layer = Layer.effect(ExternalMcpGrantStore, make);
