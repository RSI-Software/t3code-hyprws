import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

const decodePromptPair = Schema.decodeUnknownEffect(Schema.Tuple([Schema.String, Schema.String]));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Reuse the recorded restart fixture, changing only the first notification's
// terminal status. The later SendMessage and child transcript stay identical.
export const runClaudeResumeReplayFork = (priorStatus: "completed" | "failed") =>
  Effect.scoped(
    Effect.gen(function* () {
      const raw = yield* readProviderReplayTranscript(
        new URL(
          "./fixtures/claude_subagent_resume_after_restart/claude_transcript.ndjson",
          import.meta.url,
        ),
      );
      let changed = false;
      const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
        ...raw,
        entries: raw.entries.map((entry) => {
          if (
            !changed &&
            entry.type === "emit_inbound" &&
            isRecord(entry.frame) &&
            entry.frame.subtype === "task_notification"
          ) {
            changed = true;
            return { ...entry, frame: { ...entry.frame, status: priorStatus } };
          }
          return entry;
        }),
      });
      assert.isTrue(changed);
      const [launchPrompt, resumePrompt] = yield* decodePromptPair(transcript.metadata?.prompts);
      const workspace = yield* checkpointWorkspace(transcript.scenario);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-resumed-child-routing-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: transcript.scenario,
        fixtureInput: {
          steps: [
            { type: "message", text: launchPrompt },
            { type: "message", text: resumePrompt },
          ],
        },
        driver: ProviderDriverKind.make("claudeAgent"),
        modelSelection: CLAUDE_MODEL_SELECTION,
      });
      const splitIndex = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
      assert.isAtLeast(splitIndex, 0);
      const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
      const options = {
        databaseLayer: makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite")).pipe(
          Layer.provide(NodeServices.layer),
        ),
      };
      const runPhase = (steps: typeof materialized.steps, name: string) =>
        Effect.scoped(
          runOrchestratorV2ProviderReplayScenario(
            {
              name,
              transcript,
              steps,
              commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
              projectionThreadIds: materialized.projectionThreadIds,
              runtimePolicyOverride: { cwd: workspace },
            },
            harness,
            options,
          ),
        );
      const first = yield* runPhase(
        materialized.steps.slice(0, splitIndex + 1),
        `resume:${priorStatus}:launch`,
      );
      const firstParent = first.projections.get(materialized.projectionThreadIds[0]!);
      assert.equal(firstParent?.subagents[0]?.status, priorStatus);
      const result = yield* runPhase(
        materialized.steps.slice(splitIndex + 1),
        `resume:${priorStatus}:restart`,
      );
      yield* assertComplete;
      return { first, result, transcript };
    }).pipe(
      provideDeterministicTestRuntime,
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    ),
  );

export const runCodexContinueReplayFork = Effect.scoped(
  Effect.gen(function* () {
    const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find(
      (candidate) => candidate.name === "subagent_continue",
    );
    assert.isDefined(fixture);
    const provider = fixture.providers.find((candidate) => candidate.driver === "codex");
    assert.isDefined(provider);
    const input = fixture.buildInput();
    const workspace = yield* checkpointWorkspace(fixture.name, input.workspaceFiles);
    const raw = yield* readProviderReplayTranscript(provider.transcriptFile);
    const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptWorkspace(raw, workspace),
    );
    const materialized = yield* materializeFixtureInput({
      scenario: fixture.name,
      fixtureInput: input,
      driver: provider.driver,
      modelSelection: provider.modelSelection,
    });
    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: "subagent_continue/codex:exact-once",
        transcript,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { cwd: workspace },
      },
      CodexOrchestratorReplayHarness,
    );
    provider.assertOutput(result, transcript);
    return { result, transcript };
  }).pipe(
    provideDeterministicTestRuntime,
    Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
  ),
);
