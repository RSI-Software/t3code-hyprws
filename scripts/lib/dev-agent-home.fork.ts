import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
type JsonObject = typeof JsonObject.Type;
const asObject = Schema.decodeUnknownOption(JsonObject);
const EMPTY: JsonObject = {};
const objectOf = (value: unknown) => Option.getOrElse(asObject(value), () => EMPTY);

interface Format {
  readonly parse: (text: string) => Option.Option<JsonObject>;
  readonly stringify: (value: JsonObject) => string;
}
const json: Format = {
  parse: Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject)),
  stringify: Schema.encodeSync(Schema.fromJsonString(JsonObject)),
};
const parseTomlOption = Option.liftThrowable(parseToml);
const toml: Format = {
  parse: (text) => Option.flatMap(parseTomlOption(text), asObject),
  stringify: stringifyToml,
};

class MalformedConfig extends Schema.TaggedError<MalformedConfig>()("MalformedConfig", {
  path: Schema.String,
}) {
  override get message(): string {
    return `${this.path} does not parse; left as is`;
  }
}

type PrepareError = PlatformError.PlatformError | MalformedConfig;
/** Only a missing file reads as empty; a malformed one stops the copy so it is never rewritten. */
type Read = (file: string, format: Format) => Effect.Effect<JsonObject, PrepareError>;
interface Homes {
  readonly host: Read;
  readonly dev: Read;
  readonly write: (
    file: string,
    format: Format,
    value: JsonObject,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}

interface AgentHome {
  readonly agent: string;
  readonly envVar: string;
  readonly hostDir: string;
  /** Off by default in dev: account-level connectors bring the developer's tools back. */
  readonly env: Record<string, string>;
  readonly copySignIn: (homes: Homes) => Effect.Effect<void, PrepareError>;
}

const claude: AgentHome = {
  agent: "claude",
  envVar: "CLAUDE_CONFIG_DIR",
  hostDir: ".claude",
  env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
  copySignIn: Effect.fnUntraced(function* ({ host, dev, write }) {
    const ownOauth = objectOf((yield* dev(".credentials.json", json)).claudeAiOauth);
    const hostOauth = asObject((yield* host(".credentials.json", json)).claudeAiOauth);
    // Without the refresh token this copy can never rotate it and sign the developer out.
    // A login made in the dev home has its own refresh token; keep that one.
    if (Option.isSome(hostOauth) && ownOauth.refreshToken === undefined) {
      const { refreshToken: _, refreshTokenExpiresAt: __, ...access } = hostOauth.value;
      yield* write(".credentials.json", json, { claudeAiOauth: access });
    }

    // Sign-in through a proxy or key helper lives in settings, not credentials.
    const hostSettings = yield* host("settings.json", json);
    const ownSettings = yield* dev("settings.json", json);
    const authEnv = Object.entries(objectOf(hostSettings.env)).filter(([name]) =>
      name.startsWith("ANTHROPIC_"),
    );
    yield* write("settings.json", json, {
      ...ownSettings,
      ...(hostSettings.apiKeyHelper === undefined
        ? {}
        : { apiKeyHelper: hostSettings.apiKeyHelper }),
      env: { ...objectOf(ownSettings.env), ...Object.fromEntries(authEnv) },
    });
  }),
};

const codex: AgentHome = {
  agent: "codex",
  envVar: "CODEX_HOME",
  hostDir: ".codex",
  env: {},
  copySignIn: Effect.fnUntraced(function* ({ host, dev, write }) {
    const hostAuth = yield* host("auth.json", json);
    const ownTokens = objectOf((yield* dev("auth.json", json)).tokens);
    // Same rule as Claude. Codex requires the field, so it is blanked, not dropped.
    if (Object.keys(hostAuth).length > 0 && !ownTokens.refresh_token) {
      const tokens = asObject(hostAuth.tokens);
      yield* write("auth.json", json, {
        ...hostAuth,
        ...(Option.isSome(tokens) ? { tokens: { ...tokens.value, refresh_token: "" } } : {}),
      });
    }

    // Sign-in through a proxy lives in the model provider config.
    const hostConfig = yield* host("config.toml", toml);
    const ownConfig = yield* dev("config.toml", toml);
    yield* write("config.toml", toml, {
      ...ownConfig,
      ...(hostConfig.model_provider === undefined
        ? {}
        : { model_provider: hostConfig.model_provider }),
      model_providers: {
        ...objectOf(ownConfig.model_providers),
        ...objectOf(hostConfig.model_providers),
      },
      // ChatGPT connectors come with the account, like claude.ai connectors.
      features: { ...objectOf(ownConfig.features), apps: false },
    });
  }),
};

/**
 * Worktree dev servers run Claude from `.t3/claude` and Codex from `.t3/codex`, so test agents
 * get the developer's sign-in but none of their MCP servers, connectors, plugins, hooks or
 * instructions.
 */
export const isolateDevAgentHomes = Effect.fn("dev-runner.isolateDevAgentHomes")(function* (
  env: NodeJS.ProcessEnv,
  mode: string,
  worktreeHome: string | undefined,
) {
  // An explicit --home-dir keeps the developer's agents; `dev:web` runs no agents.
  if (worktreeHome === undefined || mode === "dev:web") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userHome = yield* HostProcess.HomeDirectory;

  for (const home of [claude, codex]) {
    const source = env[home.envVar]?.trim() || path.join(userHome, home.hostDir);
    const target = path.join(worktreeHome, home.agent);
    env[home.envVar] = target;
    Object.assign(env, home.env);

    const read =
      (dir: string): Read =>
      (file, format) => {
        const filePath = path.join(dir, file);
        return fs.readFileString(filePath).pipe(
          Effect.flatMap((text) =>
            Effect.fromOption(format.parse(text)).pipe(
              Effect.mapError(() => new MalformedConfig({ path: filePath })),
            ),
          ),
          Effect.catchIf(
            (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
            () => Effect.succeed(EMPTY),
          ),
        );
      };
    yield* fs.makeDirectory(target, { recursive: true }).pipe(
      Effect.andThen(
        home.copySignIn({
          host: read(source),
          dev: read(target),
          write: (file, format, value) =>
            fs.writeFileString(path.join(target, file), format.stringify(value), { mode: 0o600 }),
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning(
          `[dev-runner] could not prepare ${target} for ${home.agent}: ${error.message}`,
        ),
      ),
    );
  }
});
