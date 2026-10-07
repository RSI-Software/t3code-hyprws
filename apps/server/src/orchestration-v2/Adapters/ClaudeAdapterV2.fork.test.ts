import { ClaudeSettings, type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";
import { withClaudeAgentQueryIdentity } from "../../provider/ClaudeAgentOptions.fork.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { runClaudeResumeReplayFork } from "../testkit/ResumedSubagentReplay.fork.ts";
import { projectionFor } from "../testkit/fixtures/shared.ts";

const SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

const withAgent = (agent: string): ModelSelection => ({
  ...SELECTION,
  options: [{ id: "agent", value: agent }],
});

const queryOptions = (modelSelection: ModelSelection, launchArgs = "", resume = false) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection,
    nativeThreadId: "agent-thread",
    resume,
    cwd: "/workspace",
    settings: { ...SETTINGS, launchArgs },
  });

it.effect("claims the resumed subagent before its parent node, child root and prompt", () =>
  Effect.gen(function* () {
    const { result, transcript } = yield* runClaudeResumeReplayFork("failed");
    const parent = projectionFor(result, transcript.scenario);
    const task = parent.subagents[0]!;
    const runId = parent.runs[1]!.id;
    const events = result.domainEvents;
    const node = events.findIndex(
      (event) =>
        event.type === "node.updated" &&
        event.payload.id === task.id &&
        event.payload.runId === runId &&
        event.payload.status === "running",
    );
    const row = events.findIndex(
      (event) =>
        event.type === "subagent.updated" &&
        event.payload.id === task.id &&
        event.payload.runId === runId &&
        event.payload.status === "running",
    );
    const childRoot = events.findIndex(
      (event, index) =>
        index > node &&
        event.type === "node.updated" &&
        event.threadId === task.childThreadId &&
        event.payload.kind === "root_turn" &&
        event.payload.status === "running",
    );
    const prompt = events.findIndex(
      (event, index) =>
        index > node &&
        event.type === "message.updated" &&
        event.threadId === task.childThreadId &&
        event.payload.role === "user",
    );
    assert.isAtLeast(row, 0);
    assert.isAbove(node, row);
    assert.isAbove(childRoot, node);
    assert.isAbove(prompt, childRoot);
  }),
);

describe("Claude main-thread agent selection", () => {
  it("passes the selected agent to the SDK over a configured --agent", () => {
    assert.equal(queryOptions(withAgent("reviewer")).extraArgs?.agent, "reviewer");
    assert.equal(
      queryOptions(withAgent("reviewer"), "--agent configured").extraArgs?.agent,
      "reviewer",
    );
  });

  it("passes the selected agent when resuming the thread", () => {
    const options = queryOptions(withAgent("reviewer"), "--agent configured", true);
    assert.equal(options.resume, "agent-thread");
    assert.equal(options.extraArgs?.agent, "reviewer");
  });

  it("clears a configured --agent when the selection is default", () => {
    const options = queryOptions(withAgent("default"), "--agent configured");
    assert.notProperty(options.extraArgs ?? {}, "agent");
  });

  it("leaves launch args and query identity unchanged without a selection", () => {
    assert.equal(queryOptions(SELECTION, "--agent configured").extraArgs?.agent, "configured");
    assert.notProperty(queryOptions(SELECTION).extraArgs ?? {}, "agent");
    const compiled = compileClaudeModelSelection(SELECTION);
    assert.strictEqual(withClaudeAgentQueryIdentity(compiled, SELECTION), compiled);
  });

  it("reopens the query when the agent changes", () => {
    const identity = (selection: ModelSelection) =>
      withClaudeAgentQueryIdentity(compileClaudeModelSelection(selection), selection).queryIdentity;
    const identities = new Set([
      identity(SELECTION),
      identity(withAgent("default")),
      identity(withAgent("reviewer")),
      identity(withAgent("planner")),
    ]);
    assert.equal(identities.size, 4);
  });
});
