import {
  VoiceTextSettingsFork,
  type VoiceTextConfigFork,
  type VoiceTextConfigureFork,
  type VoiceTextTransformFork,
  type VoiceTextContextFork,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { expandVoiceTextTemplateFork, voiceRecentMessagesFork } from "./voiceTextPrompts.fork.ts";
import { voiceTextGeneratorFork } from "../textGeneration/VoiceTextGeneration.fork.ts";

export class VoiceTextError extends Schema.TaggedError<VoiceTextError>()("VoiceTextError", {
  reason: Schema.Literals(["settings", "project", "model", "response", "context", "disabled"]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.reason) {
      case "settings":
        return "Could not load or save text processing settings.";
      case "project":
        return "The project or thread is no longer available.";
      case "model":
        return "Text generation failed. Check the selected provider and model.";
      case "response":
        return "The model returned empty text. Your draft was preserved.";
      case "context":
        return "Could not read this project's context sources.";
      case "disabled":
        return "Enable this text processing action in Dictation settings.";
    }
  }
}

export class VoiceText extends Context.Service<
  VoiceText,
  {
    readonly settings: Effect.Effect<VoiceTextSettingsFork, VoiceTextError>;
    readonly configure: (
      input: VoiceTextConfigureFork,
    ) => Effect.Effect<VoiceTextSettingsFork, VoiceTextError>;
    readonly transform: (
      input: VoiceTextTransformFork,
    ) => Effect.Effect<{ text: string }, VoiceTextError>;
    readonly generateContext: (
      input: VoiceTextContextFork,
    ) => Effect.Effect<{ text: string }, VoiceTextError>;
  }
>()("t3/voice-input/VoiceText.fork/VoiceText") {}

const codec = Schema.fromJsonString(VoiceTextSettingsFork);
const decode = Schema.decodeEffect(codec);
const encode = Schema.encodeEffect(codec);
const SECRET_NAME = "fork-voice-text";

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writes = yield* Semaphore.make(1);
  const save = (settings: VoiceTextSettingsFork) =>
    encode(settings).pipe(
      Effect.flatMap((json) => secrets.set(SECRET_NAME, new TextEncoder().encode(json))),
      Effect.mapError((cause) => new VoiceTextError({ reason: "settings", cause })),
      Effect.as(settings),
    );
  const read = Effect.gen(function* () {
    const stored = yield* secrets
      .get(SECRET_NAME)
      .pipe(Effect.mapError((cause) => new VoiceTextError({ reason: "settings", cause })));
    if (Option.isSome(stored))
      return yield* decode(new TextDecoder().decode(stored.value)).pipe(
        Effect.mapError((cause) => new VoiceTextError({ reason: "settings", cause })),
      );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => new VoiceTextError({ reason: "settings", cause })),
    );
    return yield* save({
      defaults: {
        modelSelection: settings.textGenerationModelSelection,
        cleanupMode: "manual",
        formattingMode: "manual",
        formattingMinWords: 50,
        recentMessageCount: 0,
        projectContext: "",
        ...VOICE_TEXT_STARTER_PROMPTS_FORK,
      },
      projects: {},
    });
  });
  const settings = writes.withPermits(1)(read);
  const projectFor = (projectId: VoiceTextTransformFork["projectId"]) =>
    projects.get(projectId).pipe(
      Effect.mapError((cause) => new VoiceTextError({ reason: "project", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new VoiceTextError({ reason: "project" })),
          onSome: Effect.succeed,
        }),
      ),
    );
  const generate = Effect.fn("VoiceText.generate")(function* (
    config: VoiceTextConfigFork,
    cwd: string,
    prompt: string,
  ) {
    const instance = yield* registry.getInstance(config.modelSelection.instanceId);
    const generateText = instance?.enabled
      ? voiceTextGeneratorFork(instance.textGeneration)
      : undefined;
    if (!generateText) {
      return yield* new VoiceTextError({ reason: "model" });
    }
    const result = yield* generateText({
      cwd,
      prompt,
      modelSelection: config.modelSelection,
    }).pipe(Effect.mapError((cause) => new VoiceTextError({ reason: "model", cause })));
    const text = result.text.trim();
    if (!text) return yield* new VoiceTextError({ reason: "response" });
    return { text };
  });
  return VoiceText.of({
    settings,
    configure: (input) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* read;
          if (input.projectId) {
            yield* projectFor(input.projectId);
            const { [input.projectId]: _removed, ...rest } = previous.projects;
            return yield* save({
              ...previous,
              projects: input.config ? { ...rest, [input.projectId]: input.config } : rest,
            });
          }
          if (!input.config) return yield* new VoiceTextError({ reason: "settings" });
          return yield* save({ ...previous, defaults: input.config });
        }),
      ),
    transform: Effect.fn("VoiceText.transform")(function* (input) {
      const saved = yield* settings;
      const config = saved.projects[input.projectId] ?? saved.defaults;
      const mode = input.operation === "cleanup" ? config.cleanupMode : config.formattingMode;
      if (mode === "off") return yield* new VoiceTextError({ reason: "disabled" });
      const project = yield* projectFor(input.projectId);
      let cwd = project.workspaceRoot;
      let recentMessages = "";
      if (input.threadId) {
        const thread = yield* projections
          .getThread(input.threadId)
          .pipe(Effect.mapError((cause) => new VoiceTextError({ reason: "project", cause })));
        if (thread.projectId !== input.projectId)
          return yield* new VoiceTextError({ reason: "project" });
        cwd = thread.worktreePath ?? cwd;
        if (config.recentMessageCount > 0) {
          const records = yield* projections
            .getThreadRecords(input.threadId, ["messages"], {
              messageRoles: ["user", "assistant"],
            })
            .pipe(Effect.mapError((cause) => new VoiceTextError({ reason: "project", cause })));
          recentMessages = voiceRecentMessagesFork(records.messages, config.recentMessageCount);
        }
      }
      return yield* generate(
        config,
        cwd,
        expandVoiceTextTemplateFork(
          input.operation === "cleanup" ? config.cleanupPrompt : config.formattingPrompt,
          {
            text: input.text,
            project_context: config.projectContext,
            recent_messages: recentMessages,
          },
        ),
      );
    }),
    generateContext: Effect.fn("VoiceText.generateContext")(function* (input) {
      const saved = yield* settings;
      const config = input.config ?? saved.projects[input.projectId] ?? saved.defaults;
      const project = yield* projectFor(input.projectId);
      const root = yield* fs
        .realPath(project.workspaceRoot)
        .pipe(Effect.mapError((cause) => new VoiceTextError({ reason: "context", cause })));
      const sources = yield* Effect.forEach(["README.md", "AGENTS.md", "package.json"], (name) =>
        Effect.gen(function* () {
          const file = yield* fs.realPath(path.join(root, name));
          if (!file.startsWith(`${root}${path.sep}`)) return "";
          const stat = yield* fs.stat(file);
          if (stat.type !== "File" || Number(stat.size) > 128_000) return "";
          return `${name}:\n${(yield* fs.readFileString(file)).slice(0, 12_000)}`;
        }).pipe(Effect.orElseSucceed(() => "")),
      );
      return yield* generate(
        config,
        root,
        expandVoiceTextTemplateFork(config.contextPrompt, {
          project_sources: [`Project: ${project.title}`, ...sources].filter(Boolean).join("\n\n"),
        }),
      );
    }),
  });
});

export const layer = Layer.effect(VoiceText, make);
