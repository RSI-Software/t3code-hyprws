import type { ModelSelection } from "@t3tools/contracts";

import type { TextGeneration } from "../textGeneration/TextGeneration.ts";

export function buildThreadGroupTitleMessage(memberTitles: readonly string[]): string {
  return [
    "Name a visual sidebar group containing these related T3 Code threads:",
    ...memberTitles.map((title) => `- ${title}`),
  ].join("\n");
}

export function generateThreadGroupTitle(
  textGeneration: TextGeneration["Service"],
  input: {
    readonly cwd: string;
    readonly memberTitles: readonly string[];
    readonly previousTitle?: string | undefined;
    readonly modelSelection: ModelSelection;
  },
) {
  return textGeneration.generateThreadTitle({
    cwd: input.cwd,
    message: buildThreadGroupTitleMessage(input.memberTitles),
    ...(input.previousTitle === undefined ? {} : { previousTitle: input.previousTitle }),
    modelSelection: input.modelSelection,
  });
}
