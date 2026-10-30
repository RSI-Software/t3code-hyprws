import type { ProviderReplayTranscript } from "@t3tools/contracts";
import {
  THREAD_ARTIFACT_LINKING_INSTRUCTION_FORK,
  THREAD_ISSUE_LINKING_INSTRUCTION_FORK,
} from "@t3tools/provider-core/server/RuntimeInstructions.fork";

/** In `runtimeInstructions.ts` order, each on its own line before `</pull_request_linking>`. */
const FORK_INSTRUCTIONS = [
  THREAD_ISSUE_LINKING_INSTRUCTION_FORK,
  THREAD_ARTIFACT_LINKING_INSTRUCTION_FORK,
];

/** Keep recorded Muse prompts exact while adding the fork's runtime instructions. */
export function materializeForkReplayRuntimeInstructions(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  if (transcript.provider !== "muse") return transcript;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!value.includes("<pull_request_linking>")) return value;
      return FORK_INSTRUCTIONS.reduce(
        (text, instruction) =>
          text.includes(instruction)
            ? text
            : text.replace(
                "\n</pull_request_linking>",
                `\n${instruction}\n</pull_request_linking>`,
              ),
        value,
      );
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    }
    return value;
  };
  return {
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "runtime_exit" ? entry : { ...entry, frame: rewrite(entry.frame) },
    ),
  };
}
