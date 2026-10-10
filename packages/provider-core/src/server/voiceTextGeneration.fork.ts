import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ModelSelection, TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { Operation, Request, Runner } from "./textGenerationOperations.ts";

type VoiceTextGeneratorFork = (input: {
  cwd: string;
  prompt: string;
  modelSelection: ModelSelection;
}) => Effect.Effect<{ text: string }, TextGenerationError>;

type VoiceRunnerFork = <S extends Schema.Top>(
  request: Omit<Request<S>, "operation"> & { operation: Operation | "generateTextFork" },
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Provider runners handle arbitrary prompts and schemas; the fork adds one named operation. */
export function withVoiceTextGenerationFork<T extends ProviderTextGeneration>(
  service: T,
  runner: Runner,
) {
  const run = runner as VoiceRunnerFork;
  return {
    ...service,
    generateTextFork: (input: Parameters<VoiceTextGeneratorFork>[0]) =>
      run({
        ...input,
        operation: "generateTextFork",
        prompt: `${input.prompt}\n\nReturn a JSON object with a single string field named text containing the result.`,
        outputSchema: Schema.Struct({ text: Schema.String }),
      }),
  };
}

/** The registry exposes upstream service types; discover the optional fork capability here. */
export function voiceTextGeneratorFork(service: ProviderTextGeneration) {
  return (service as ProviderTextGeneration & { generateTextFork?: VoiceTextGeneratorFork })
    .generateTextFork;
}
