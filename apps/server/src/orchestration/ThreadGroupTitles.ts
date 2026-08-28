import type { ModelSelection } from "@t3tools/contracts";

import type { TextGeneration } from "../textGeneration/TextGeneration.ts";

// The thread-title prompt titles whatever the user asked for, so an
// instruction here becomes the title ("Name Sidebar Thread Group"). Each
// member title stands in as one user request, in the USER-section shape of
// regenerated thread contents, so the group is titled by their shared subject.
function buildThreadGroupTitleMessage(memberTitles: readonly string[]): string {
  return memberTitles.map((title) => `USER:\n${title}`).join("\n\n");
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
