// Fork-only (zmux-estate): a committed checkout move detaches the thread's
// provider session instead of restarting it in the destination. These replays
// prove the next turn still continues the same native conversation, now in the
// destination checkout, for the providers that hold one.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  ProviderDriverKind,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CodexReplay from "effect-codex-app-server/replay";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import {
  CodexOrchestratorReplayHarness,
  layer as codexReplayRegistryLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import * as IdAllocator from "../IdAllocator.ts";
import type { OrchestratorV2ScenarioStep } from "./OrchestratorScenario.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CLAUDE_IDLE_RESUME_PROMPT_1,
  CLAUDE_IDLE_RESUME_PROMPT_2,
} from "./fixtures/claude_idle_resume/input.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./ReplayTranscriptNdjson.ts";

/**
 * Two turns on a thread that starts in `source`, with the checkout move's
 * commit landing between them, as `CheckoutMoveServiceFork` dispatches it.
 */
const materializeMovedThread = Effect.fn("materializeMovedThread")(function* (input: {
  readonly scenario: string;
  readonly driver: ProviderDriverKind;
  readonly modelSelection: typeof CLAUDE_MODEL_SELECTION | typeof CODEX_MODEL_SELECTION;
  readonly prompts: readonly [string, string];
  readonly source: string;
  readonly destination: string;
}) {
  const materialized = yield* materializeFixtureInput({
    scenario: input.scenario,
    fixtureInput: { steps: input.prompts.map((text) => ({ type: "message" as const, text })) },
    driver: input.driver,
    modelSelection: input.modelSelection,
  });
  const threadId = materialized.projectionThreadIds[0]!;
  const commit: OrchestrationV2Command = {
    type: "thread.metadata.update",
    commandId: CommandId.make(`${input.scenario}:checkout-move-commit`),
    threadId,
    expectedWorktreePath: input.source,
    worktreePath: input.destination,
  };
  const firstIdle = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
  const inSource = (step: OrchestratorV2ScenarioStep): OrchestratorV2ScenarioStep =>
    step.type === "dispatch" && step.command.type === "thread.create"
      ? { ...step, command: { ...step.command, worktreePath: input.source } }
      : step;
  const steps: ReadonlyArray<OrchestratorV2ScenarioStep> = [
    ...materialized.steps.slice(0, firstIdle + 1).map(inSource),
    { type: "dispatch", command: commit, await: true },
    { type: "advance_clock", duration: "1 millis" },
    ...materialized.steps.slice(firstIdle + 1),
  ];
  return {
    steps,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    projectionThreadIds: materialized.projectionThreadIds,
  };
});

/**
 * The recorded resume, replayed on the live app-server a checkout move leaves
 * running: the first runtime's exit and re-initialize become the detach's
 * `thread/unsubscribe`, and `<workspace>` resolves to `source` before the move
 * and to `destination` after it.
 */
function codexTranscriptAcrossMove(
  transcript: ProviderReplayTranscript,
  source: string,
  destination: string,
): ProviderReplayTranscript {
  const exit = transcript.entries.findIndex((entry) => entry.type === "runtime_exit");
  const resume = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "thread/resume",
  );
  const before = transcript.entries.slice(0, exit);
  const lastId = Math.max(
    ...before.map((entry) =>
      "frame" in entry && isRecord(entry.frame) && typeof entry.frame.id === "number"
        ? entry.frame.id
        : 0,
    ),
  );
  const unsubscribeId = lastId + 1;
  const resumeId = (transcript.entries[resume] as { readonly frame: { readonly id: number } }).frame
    .id;
  // Requests after the move continue this connection's id sequence.
  const shift = unsubscribeId + 1 - resumeId;
  const after = transcript.entries
    .slice(resume)
    .map((entry) =>
      "frame" in entry && isRecord(entry.frame) && typeof entry.frame.id === "number"
        ? { ...entry, frame: { ...entry.frame, id: entry.frame.id + shift } }
        : entry,
    );
  const nativeThreadId = (
    transcript.entries[resume] as { readonly frame: { readonly params: { threadId: string } } }
  ).frame.params.threadId;
  const part = (entries: ProviderReplayTranscript["entries"], workspace: string) =>
    materializeReplayTranscriptWorkspace({ ...transcript, entries }, workspace).entries;
  return {
    ...transcript,
    entries: [
      ...part(before, source),
      {
        type: "expect_outbound",
        label: "thread/unsubscribe",
        frame: {
          id: unsubscribeId,
          method: "thread/unsubscribe",
          params: { threadId: nativeThreadId },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/unsubscribe",
        frame: { id: unsubscribeId, result: { status: "unsubscribed" } },
      },
      ...part(after, destination),
    ],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeCodexTranscript = Schema.decodeUnknownEffect(
  CodexReplay.CodexAppServerReplayTranscript,
);

describe("checkout move session continuity", () => {
  it.effect("resumes the Codex thread in the destination checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* checkpointWorkspace("provider_thread_resume");
        const destination = yield* checkpointWorkspace("provider_thread_resume_destination");
        const recorded = yield* readProviderReplayTranscript(
          new URL("./fixtures/provider_thread_resume/codex_transcript.ndjson", import.meta.url),
        );
        // thread/resume must name the recorded native thread and the destination cwd.
        const transcript = yield* decodeCodexTranscript(
          codexTranscriptAcrossMove(recorded, source, destination),
        );
        const driver = yield* CodexReplay.makeReplayDriver(transcript);
        const moved = yield* materializeMovedThread({
          scenario: "provider_thread_resume",
          driver: ProviderDriverKind.make("codex"),
          modelSelection: CODEX_MODEL_SELECTION,
          prompts: [PROVIDER_THREAD_RESUME_FIRST_PROMPT, PROVIDER_THREAD_RESUME_SECOND_PROMPT],
          source,
          destination,
        });
        const result = yield* runOrchestratorV2ProviderReplayScenario(
          { name: "checkout-move/codex", transcript, ...moved },
          {
            ...CodexOrchestratorReplayHarness,
            makeProviderAdapterRegistryLayer: () =>
              codexReplayRegistryLayer({ transcript, driver }),
          },
        );
        const projection = projectionFor(result, transcript.scenario);
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.lengthOf(projection.providerThreads, 1);
        assert.equal(projection.thread.worktreePath, destination);
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );

  it.effect("resumes the Claude session in the destination checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* checkpointWorkspace("claude_idle_resume");
        const destination = yield* checkpointWorkspace("claude_idle_resume_destination");
        // query.open:2 is recorded as a `resume` of the first turn's session.
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
          yield* readProviderReplayTranscript(
            new URL("./fixtures/claude_idle_resume/claude_transcript.ndjson", import.meta.url),
          ),
        );
        const moved = yield* materializeMovedThread({
          scenario: "claude_idle_resume",
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
          prompts: [CLAUDE_IDLE_RESUME_PROMPT_1, CLAUDE_IDLE_RESUME_PROMPT_2],
          source,
          destination,
        });
        const result = yield* runOrchestratorV2ProviderReplayScenario(
          { name: "checkout-move/claude", transcript, ...moved },
          ClaudeOrchestratorReplayHarness,
        );
        const projection = projectionFor(result, transcript.scenario);
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.lengthOf(projection.providerThreads, 1);
        // The query's cwd is not part of the replay frame; the session records it.
        assert.deepEqual(
          projection.providerSessions.map((session) => session.cwd),
          [destination],
        );
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );
});
