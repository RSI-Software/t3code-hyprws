// Spike RSI-714: before dispatch, one cheap text-generation call decides whether a shared-thread
// line goes to the agent at all. People lines spend no agent turn and fold into the next one.
import type { ModelSelection } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";

import { FOR_AGENT_CRITERIA_SPIKE } from "./CollaboratorMessages.fork.ts";

export interface SharedThreadLineSpike {
  /** A person's name, or "Agent" for the agent's own replies. */
  readonly name: string;
  readonly text: string;
}

export type SharedThreadRouteSpike = "agent" | "people";

const RECENT_LINES = 12;
const LINE_CHARS = 400;

const clip = (text: string) =>
  text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS)}...` : text;

export const sharedThreadRoutePrompt = (input: {
  readonly people: ReadonlyArray<string>;
  readonly recent: ReadonlyArray<SharedThreadLineSpike>;
  readonly line: SharedThreadLineSpike;
}) =>
  [
    `You route messages in a shared coding thread. ${input.people.join(" and ")} talk to each other and to an AI coding agent ("Agent") in the same thread.`,
    `Decide whether the newest message should go to the agent. ${FOR_AGENT_CRITERIA_SPIKE}`,
    "",
    "Recent thread, oldest first:",
    ...(input.recent.length === 0
      ? ["(nothing yet)"]
      : input.recent.slice(-RECENT_LINES).map((line) => `${line.name}: ${clip(line.text)}`)),
    "",
    `Newest message, from ${input.line.name}:`,
    clip(input.line.text),
    "",
    'Reply with JSON whose "transcription" field is exactly "agent" or "people".',
  ].join("\n");

/**
 * Reuses the raw-prompt operation the thread-title path's runner already serves, so the router
 * needs no new client. A failed or unclear answer routes to the agent: a miss costs more.
 */
export const routeSharedThreadLineSpike = Effect.fn("SharedThreadRouterSpike.route")(function* (
  textGeneration: Pick<ProviderTextGeneration, "generateTranscriptionPostProcessing">,
  input: {
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly people: ReadonlyArray<string>;
    readonly recent: ReadonlyArray<SharedThreadLineSpike>;
    readonly line: SharedThreadLineSpike;
  },
) {
  const result = yield* textGeneration
    .generateTranscriptionPostProcessing({
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      prompt: sharedThreadRoutePrompt(input),
    })
    .pipe(Effect.option);
  const route: SharedThreadRouteSpike =
    result._tag === "Some" && result.value.transcription.trim().toLowerCase() === "people"
      ? "people"
      : "agent";
  return route;
});
