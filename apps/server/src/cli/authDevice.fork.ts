import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as DeviceAuthorization from "../auth/DeviceAuthorization.fork.ts";
import type * as ExternalMcpGrant from "../auth/ExternalMcpGrant.fork.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

// The owner's half of the device authorization grant. Nothing here prints a
// device code or token: the client receives its token by polling directly.

const runWithDeviceAuthorization = <A, E>(
  flags: CliAuthLocationFlags,
  run: (store: DeviceAuthorization.DeviceAuthorizationStore["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.gen(function* () {
      return yield* run(yield* DeviceAuthorization.DeviceAuthorizationStore);
    }).pipe(
      Effect.provide(
        DeviceAuthorization.layer.pipe(
          Layer.provide(EnvironmentAuth.runtimeLayer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(
            Layer.succeed(
              References.MinimumLogLevel,
              options?.quietLogs ? "Error" : config.logLevel,
            ),
          ),
        ),
      ),
    );
  });

const ENVIRONMENT_SCOPES = new Set<AuthEnvironmentScope>(AuthAdministrativeScopes);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const userCodeArgument = Argument.String("user-code").pipe(
  Argument.withDescription("The code the client displays, for example `BCDF-GHJK`."),
);

// Client fields come from an unauthenticated request, so they print as
// escaped JSON strings that cannot move the cursor, recolor, or reorder text.
const quoted = (value: string | null | undefined) =>
  value == null ? "-" : DeviceAuthorization.escapeForTerminal(value);

const formatDeviceAuthorizationList = (
  requests: ReadonlyArray<DeviceAuthorization.DeviceAuthorizationRequest>,
) => {
  if (requests.length === 0) return "No pending device authorizations.\n";
  return `${requests
    .map((request) =>
      [
        `${request.userCode}  ${request.status}  expires ${request.expiresAt}`,
        `  label: ${quoted(request.client.label)}`,
        `  device: ${request.client.deviceType} ${quoted(request.client.os)}`,
        `  ip: ${quoted(request.client.ipAddress)}`,
        `  user agent: ${quoted(request.client.userAgent)}`,
        `  key thumbprint: ${request.proofKeyThumbprint ?? "none (bearer)"}`,
        `  requested scopes: ${request.requestedScopes?.join(" ") ?? "none (standard client scopes)"}`,
      ].join("\n"),
    )
    .join("\n\n")}\n`;
};

const deviceListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List device authorizations waiting for a decision or a poll."),
  Command.withHandler((flags) =>
    runWithDeviceAuthorization(
      flags,
      (store) =>
        store
          .listOpen()
          .pipe(
            Effect.flatMap((requests) =>
              Console.log(
                flags.json
                  ? DeviceAuthorization.escapeForTerminal(requests)
                  : formatDeviceAuthorizationList(requests),
              ),
            ),
          ),
      { quietLogs: flags.json },
    ),
  ),
);

/**
 * Builds the external MCP policy from the approve flags: `undefined` when no
 * MCP flag is set, a message when they do not form a policy.
 */
export const externalMcpPolicyFromFlags = (flags: {
  readonly mcpProject: ReadonlyArray<string>;
  readonly mcpAllProjects: boolean;
  readonly mcpCoordinate: boolean;
  readonly mcpMaxRuntimeMode: Option.Option<RuntimeMode>;
  readonly mcpMaxInteractionMode: Option.Option<ProviderInteractionMode>;
  readonly scope: Option.Option<string>;
}): ExternalMcpGrant.ExternalMcpPolicy | string | undefined => {
  const anyMcpFlag =
    flags.mcpProject.length > 0 ||
    flags.mcpAllProjects ||
    flags.mcpCoordinate ||
    Option.isSome(flags.mcpMaxRuntimeMode) ||
    Option.isSome(flags.mcpMaxInteractionMode);
  if (!anyMcpFlag) return undefined;
  if (Option.isSome(flags.scope)) {
    return "An external MCP grant carries no scopes; drop --scope.";
  }
  if (flags.mcpAllProjects === flags.mcpProject.length > 0) {
    return "Name the reachable projects with --mcp-project <id>, or pass --mcp-all-projects.";
  }
  return {
    projectIds: flags.mcpAllProjects ? "*" : flags.mcpProject.map((id) => ProjectId.make(id)),
    coordinate: flags.mcpCoordinate,
    maxRuntimeMode: Option.getOrElse(flags.mcpMaxRuntimeMode, () => "approval-required" as const),
    maxInteractionMode: Option.getOrElse(flags.mcpMaxInteractionMode, () => "plan" as const),
  };
};

const formatMcpPolicy = (policy: ExternalMcpGrant.ExternalMcpPolicy) => [
  `External MCP projects: ${policy.projectIds === "*" ? "all" : policy.projectIds.join(" ")}`,
  `External MCP coordination: ${policy.coordinate ? "create, send, interrupt" : "read only"}`,
  `External MCP ceilings: runtime ${policy.maxRuntimeMode}, interaction ${policy.maxInteractionMode}`,
];

const deviceApproveCommand = Command.make("approve", {
  ...authLocationFlags,
  userCode: userCodeArgument,
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Lifetime of the issued session, for example `7d` or `30d`. Default 30d."),
    Flag.optional,
  ),
  scope: Flag.String("scope").pipe(
    Flag.withDescription(
      "Space-separated scopes to grant. Narrows a request; required to grant more than the standard client scopes to a client that requested none.",
    ),
    Flag.optional,
  ),
  mcpProject: Flag.String("mcp-project").pipe(
    Flag.withDescription(
      "Grant an external MCP client instead of environment scopes, reaching this project. Repeat for more.",
    ),
    Flag.atLeast(0),
  ),
  mcpAllProjects: Flag.Boolean("mcp-all-projects").pipe(
    Flag.withDescription("Grant an external MCP client reaching every project."),
    Flag.withDefault(false),
  ),
  mcpCoordinate: Flag.Boolean("mcp-coordinate").pipe(
    Flag.withDescription(
      "Let the external MCP client create, send to, and interrupt threads. Default read only.",
    ),
    Flag.withDefault(false),
  ),
  mcpMaxRuntimeMode: Flag.Literals("mcp-max-runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDescription(
      "Highest runtime mode an external MCP client's threads may use. Default approval-required.",
    ),
    Flag.optional,
  ),
  mcpMaxInteractionMode: Flag.Literals(
    "mcp-max-interaction-mode",
    ProviderInteractionMode.literals,
  ).pipe(
    Flag.withDescription(
      "Highest interaction mode an external MCP client's threads may use. Default plan.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Approve a pending device authorization. The client receives its token on its next poll.",
  ),
  Command.withHandler((flags) =>
    runWithDeviceAuthorization(
      flags,
      (store) =>
        Effect.gen(function* () {
          const mcpPolicy = externalMcpPolicyFromFlags(flags);
          if (typeof mcpPolicy === "string") return yield* Console.log(`${mcpPolicy}\n`);
          const scopes = Option.map(flags.scope, (value) =>
            parseAllowedOAuthScope({ value, allowedScopes: ENVIRONMENT_SCOPES }),
          );
          if (Option.isSome(scopes) && scopes.value === null) {
            return yield* Console.log(
              `Unknown scope. Valid scopes: ${AuthAdministrativeScopes.join(" ")}\n`,
            );
          }
          const approved = yield* store
            .approve({
              userCode: flags.userCode,
              ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
              ...(Option.isSome(scopes) && scopes.value ? { scopes: scopes.value } : {}),
              ...(mcpPolicy ? { mcpPolicy } : {}),
            })
            .pipe(
              Effect.catchTags({
                DeviceAuthorizationScopeError: (error) =>
                  Console.log(
                    `The client did not request that scope. Grantable: ${error.allowedScopes.join(" ")}\n`,
                  ).pipe(Effect.as(undefined)),
                DeviceAuthorizationMcpPolicyError: (error) =>
                  Console.log(
                    error.reason === "unbound-request"
                      ? "An external MCP grant needs a DPoP-bound request; this client sent no proof key.\n"
                      : "An external MCP grant carries no scopes; drop --scope.\n",
                  ).pipe(Effect.as(undefined)),
              }),
            );
          if (approved === undefined) return;
          if (Option.isNone(approved)) {
            return yield* Console.log(
              `No pending device authorization found for ${flags.userCode}.\n`,
            );
          }
          const { value } = approved;
          yield* Console.log(
            flags.json
              ? DeviceAuthorization.escapeForTerminal({
                  userCode: value.userCode,
                  client: value.client,
                  scopes: value.scopes,
                  ttlMs: Duration.toMillis(value.ttl),
                  proofKeyThumbprint: value.proofKeyThumbprint,
                  mcpPolicy: value.mcpPolicy,
                })
              : [
                  `Approved ${value.userCode} for ${quoted(value.client.label)}.`,
                  `Scopes: ${value.scopes.join(" ") || "none"}`,
                  ...(value.mcpPolicy ? formatMcpPolicy(value.mcpPolicy) : []),
                  `Lifetime: ${Duration.format(value.ttl)} from the client's next poll`,
                  `Key thumbprint: ${value.proofKeyThumbprint ?? "none (bearer)"}`,
                  "Revoke later with `t3 auth session list` and `t3 auth session revoke <id>`.",
                  "",
                ].join("\n"),
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const deviceDenyCommand = Command.make("deny", {
  ...authLocationFlags,
  userCode: userCodeArgument,
}).pipe(
  Command.withDescription("Deny a device authorization so the client stops polling."),
  Command.withHandler((flags) =>
    runWithDeviceAuthorization(flags, (store) =>
      store
        .deny(flags.userCode)
        .pipe(
          Effect.flatMap((denied) =>
            Console.log(
              denied
                ? `Denied device authorization ${flags.userCode}.\n`
                : `No open device authorization found for ${flags.userCode}.\n`,
            ),
          ),
        ),
    ),
  ),
);

export const deviceCommand = Command.make("device").pipe(
  Command.withDescription("Approve native clients that start the device authorization grant."),
  Command.withSubcommands([deviceListCommand, deviceApproveCommand, deviceDenyCommand]),
);
