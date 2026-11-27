import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(JsonObject));
const asObject = Schema.decodeUnknownOption(JsonObject);
const EMPTY: typeof JsonObject.Type = {};
const objectOf = (value: unknown) => Option.getOrElse(asObject(value), () => EMPTY);

/**
 * Worktree dev servers run Claude from `.t3/claude`, so test agents get the developer's
 * sign-in but none of their MCP servers, claude.ai connectors, plugins, hooks or instructions.
 */
export const isolateDevClaudeHome = Effect.fn("dev-runner.isolateDevClaudeHome")(function* (
  env: NodeJS.ProcessEnv,
  mode: string,
  worktreeHome: string | undefined,
) {
  // An explicit --home-dir keeps the developer's Claude; `dev:web` runs no agents.
  if (worktreeHome === undefined || mode === "dev:web") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source =
    env.CLAUDE_CONFIG_DIR?.trim() || path.join(yield* HostProcess.HomeDirectory, ".claude");
  const target = path.join(worktreeHome, "claude");
  env.CLAUDE_CONFIG_DIR = target;
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";

  const readObject = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.getOrElse(decodeJsonObject(text), () => EMPTY)),
      Effect.orElseSucceed(() => EMPTY),
    );
  const writeObject = (file: string, value: Record<string, unknown>) =>
    fs.writeFileString(file, encodeJson(value), { mode: 0o600 });

  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(target, { recursive: true });

    const ownOauth = objectOf(
      (yield* readObject(path.join(target, ".credentials.json"))).claudeAiOauth,
    );
    const hostOauth = asObject(
      (yield* readObject(path.join(source, ".credentials.json"))).claudeAiOauth,
    );
    // Without the refresh token this copy can never rotate it and sign the developer out.
    // A login made in the dev home has its own refresh token; keep that one.
    if (Option.isSome(hostOauth) && ownOauth.refreshToken === undefined) {
      const { refreshToken: _, refreshTokenExpiresAt: __, ...access } = hostOauth.value;
      yield* writeObject(path.join(target, ".credentials.json"), { claudeAiOauth: access });
    }

    // Sign-in through a proxy or key helper lives in settings, not credentials.
    const hostSettings = yield* readObject(path.join(source, "settings.json"));
    const ownSettings = yield* readObject(path.join(target, "settings.json"));
    const authEnv = Object.entries(objectOf(hostSettings.env)).filter(([name]) =>
      name.startsWith("ANTHROPIC_"),
    );
    yield* writeObject(path.join(target, "settings.json"), {
      ...ownSettings,
      ...(hostSettings.apiKeyHelper === undefined
        ? {}
        : { apiKeyHelper: hostSettings.apiKeyHelper }),
      env: {
        ...objectOf(ownSettings.env),
        ...Object.fromEntries(authEnv),
      },
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`[dev-runner] could not prepare ${target} for Claude: ${error.message}`),
    ),
  );
});
