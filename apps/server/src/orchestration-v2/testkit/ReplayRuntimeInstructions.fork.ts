import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { THREAD_ISSUE_LINKING_INSTRUCTION_FORK } from "@t3tools/provider-core/server/RuntimeInstructions.fork";

/** Keep recorded Muse prompts exact while adding the fork's runtime instruction. */
export function materializeForkReplayRuntimeInstructions(
  transcript: ProviderReplayTranscript,
): ProviderReplayTranscript {
  if (transcript.provider !== "muse") return transcript;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.includes("<pull_request_linking>") &&
        !value.includes(THREAD_ISSUE_LINKING_INSTRUCTION_FORK)
        ? value.replace(
            "\n</pull_request_linking>",
            `\n${THREAD_ISSUE_LINKING_INSTRUCTION_FORK}\n</pull_request_linking>`,
          )
        : value;
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
