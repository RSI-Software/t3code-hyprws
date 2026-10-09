import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  TextGenerationError,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
  type VoiceTextConfigFork,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as TextGenerationOperations from "../textGeneration/TextGenerationOperations.ts";
import { withVoiceTextGenerationFork } from "../textGeneration/VoiceTextGeneration.fork.ts";
import * as VoiceText from "./VoiceText.fork.ts";
import { expandVoiceTextTemplateFork, voiceRecentMessagesFork } from "./voiceTextPrompts.fork.ts";

const projectId = ProjectId.make("dictation-project");
const modelSelection = {
  instanceId: ProviderInstanceId.make("dictation-model"),
  model: "test-model",
};
const config: VoiceTextConfigFork = {
  modelSelection,
  cleanupMode: "manual",
  formattingMode: "manual",
  formattingMinWords: 50,
  recentMessageCount: 0,
  projectContext: "React, Zustand, Hyprland",
  ...VOICE_TEXT_STARTER_PROMPTS_FORK,
};

function harness() {
  const stored = new Map<string, Uint8Array>();
  const calls: Array<{ prompt: string; cwd: string; modelSelection: ModelSelection }> = [];
  const reads: string[] = [];
  let serverModel = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection;
  let result = "Corrected transcription";
  let fails = false;
  const instance: ProviderInstance = {
    instanceId: modelSelection.instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    continuationIdentity: { driverKind: ProviderDriverKind.make("codex"), continuationKey: "test" },
    displayName: undefined,
    enabled: true,
    get snapshot(): never {
      throw new Error("not used");
    },
    get orchestrationAdapter(): never {
      throw new Error("not used");
    },
    textGeneration: withVoiceTextGenerationFork(
      TextGeneration.TextGeneration.of({
        generateCommitMessage: () => Effect.die("not used"),
        generatePrContent: () => Effect.die("not used"),
        generateBranchName: () => Effect.die("not used"),
        generateThreadTitle: () => Effect.die("not used"),
      }),
      (input) => {
        calls.push(input);
        return fails
          ? Effect.fail(
              new TextGenerationError({ operation: "generateTextFork", detail: "unavailable" }),
            )
          : TextGenerationOperations.decodeJsonReply(
              input,
              "test",
              JSON.stringify({ text: result }),
            );
      },
    ),
  };
  const layer = VoiceText.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
          set: (name, value) =>
            Effect.sync(() => {
              stored.set(name, value);
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(() => ({
            ...DEFAULT_SERVER_SETTINGS,
            textGenerationModelSelection: serverModel,
          })),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(id === modelSelection.instanceId ? instance : undefined),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({
                    projectId,
                    title: "Dictation project",
                    workspaceRoot: "/project",
                    defaultModelSelection: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    scripts: [],
                    createdAt: "2026-10-09T00:00:00Z",
                    updatedAt: "2026-10-09T00:00:00Z",
                    deletedAt: null,
                  })
                : Option.none(),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.die("History must not be loaded without a thread"),
          getThreadRecords: () => Effect.die("History is disabled"),
        }),
        Path.layer,
        FileSystem.layerNoop({
          realPath: (file) =>
            Effect.succeed(file.endsWith("AGENTS.md") ? "/outside/AGENTS.md" : file),
          stat: () => Effect.succeed({ type: "File", size: 100n } as FileSystem.File.Info),
          readFileString: (file) =>
            Effect.sync(() => {
              reads.push(file);
              return "Zustand and Hyprland";
            }),
        }),
      ),
    ),
  );
  const run = <A, E>(use: (service: VoiceText.VoiceText["Service"]) => Effect.Effect<A, E>) =>
    Effect.flatMap(VoiceText.VoiceText, use).pipe(Effect.provide(layer));
  return {
    run,
    calls,
    reads,
    setServerModel: (model: ModelSelection) => {
      serverModel = model;
    },
    setResult: (value: string) => {
      result = value;
    },
    fail: () => {
      fails = true;
    },
  };
}

describe("dictation text generation", () => {
  it.effect("initializes independently and retains its model when the title model changes", () =>
    Effect.gen(function* () {
      const h = harness();
      const initial = yield* h.run((s) => s.settings);
      h.setServerModel(modelSelection);
      const later = yield* h.run((s) => s.settings);
      expect(later.defaults.modelSelection).toEqual(initial.defaults.modelSelection);
      expect(later.defaults.recentMessageCount).toBe(0);
    }),
  );
  it.effect("uses the project's edited prompt, context, and independently selected model", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) =>
        s.configure({
          projectId,
          config: {
            ...config,
            cleanupPrompt: "Fix {{text}} using {{project_context}} / {{recent_messages}}",
          },
        }),
      );
      expect(
        yield* h.run((s) =>
          s.transform({ projectId, operation: "cleanup", text: "react use affect" }),
        ),
      ).toEqual({ text: "Corrected transcription" });
      expect(h.calls[0]).toMatchObject({
        cwd: "/project",
        modelSelection,
        prompt: expect.stringContaining("Fix react use affect using React, Zustand, Hyprland / "),
      });
    }),
  );
  it.effect("restores environment settings when a project override is removed", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) => s.configure({ config }));
      yield* h.run((s) => s.configure({ projectId, config: { ...config, cleanupMode: "off" } }));
      const disabled = yield* h
        .run((s) => s.transform({ projectId, operation: "cleanup", text: "draft" }))
        .pipe(Effect.flip);
      expect(disabled.reason).toBe("disabled");
      expect(h.calls).toHaveLength(0);
      yield* h.run((s) => s.configure({ projectId, config: null }));
      yield* h.run((s) => s.transform({ projectId, operation: "cleanup", text: "draft" }));
      expect(h.calls).toHaveLength(1);
    }),
  );
  it.effect("returns typed errors for empty output and model failure", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) => s.configure({ config }));
      h.setResult("  ");
      expect(
        (yield* h
          .run((s) => s.transform({ projectId, operation: "format", text: "draft" }))
          .pipe(Effect.flip)).reason,
      ).toBe("response");
      h.fail();
      expect(
        (yield* h
          .run((s) => s.transform({ projectId, operation: "format", text: "draft" }))
          .pipe(Effect.flip)).reason,
      ).toBe("model");
    }),
  );
  it.effect(
    "collects bounded project sources without following a symlink outside the project",
    () =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.run((s) => s.generateContext({ projectId, config }));
        expect(h.reads).toEqual(["/project/README.md", "/project/package.json"]);
        expect(h.calls[0]?.prompt).toContain("Project: Dictation project");
        expect(h.calls[0]?.prompt).not.toContain("AGENTS.md");
        expect((yield* h.run((s) => s.settings)).projects[projectId]).toBeUndefined();
      }),
  );
});

describe("dictation prompt context", () => {
  it("does not expand placeholders injected by source text", () => {
    expect(
      expandVoiceTextTemplateFork("{{text}} / {{project_context}}", {
        text: "literally {{project_context}}",
        project_context: "React",
      }),
    ).toBe("literally {{project_context}} / React");
  });
  it("takes the most recent user and assistant contributions and excludes working traces", () => {
    const messages = [
      { role: "user", text: "old request" },
      { role: "assistant", text: "old answer" },
      { role: "user", text: "fix useEffect" },
      { role: "assistant", text: "check dependencies" },
      { role: "assistant", text: "also check cleanup" },
      { role: "reasoning", text: "private" },
      { role: "assistant", text: "unfinished", streaming: true },
    ];
    expect(voiceRecentMessagesFork(messages, 0)).toBe("");
    expect(voiceRecentMessagesFork(messages, 2)).toBe(
      "USER:\nfix useEffect\n\nASSISTANT:\nalso check cleanup",
    );
  });
  it("keeps role labels and complete boundaries within the history budget", () => {
    const history = voiceRecentMessagesFork(
      [
        { role: "user", text: "a".repeat(4_000) },
        { role: "assistant", text: "b".repeat(4_000) },
        { role: "user", text: "c".repeat(4_000) },
        { role: "assistant", text: "d".repeat(4_000) },
      ],
      4,
    );
    expect(history).toHaveLength(12_000);
    expect(history).toMatch(/^ASSISTANT:\nb+/);
    expect(history.split("\n\n").map((entry) => entry.split("\n")[0])).toEqual([
      "ASSISTANT:",
      "USER:",
      "ASSISTANT:",
    ]);
    expect(history).toContain(`USER:\n${"c".repeat(4_000)}`);
    expect(history.endsWith(`ASSISTANT:\n${"d".repeat(4_000)}`)).toBe(true);
  });
  it.effect("shares the provider runner while enforcing the text result schema", () =>
    Effect.gen(function* () {
      const runner: TextGenerationOperations.Runner = (request) =>
        TextGenerationOperations.decodeJsonReply(request, "test", '{"text":"Use useEffect"}');
      const service = withVoiceTextGenerationFork(
        TextGenerationOperations.fromRunner("test", runner),
        runner,
      );
      expect(
        yield* service.generateTextFork!({ cwd: "/project", prompt: "Fix", modelSelection }),
      ).toEqual({ text: "Use useEffect" });
    }),
  );
});
