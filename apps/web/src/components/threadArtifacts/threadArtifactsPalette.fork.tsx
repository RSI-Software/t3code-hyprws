// Fork-owned command-palette entry for thread artifacts; upstream `CommandPalette.tsx` carries
// only marked hook lines pointing here.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { ThreadArtifactsTabIconFork } from "./threadArtifacts.fork";

/** Opens the active thread's Artifacts tab, disabled until the thread links a document. */
export function buildShowArtifactsActionItemFork(
  activeThread:
    | {
        readonly environmentId: EnvironmentId;
        readonly id: ThreadId;
        readonly artifacts?: ReadonlyArray<unknown> | undefined;
      }
    | null
    | undefined,
): CommandPaletteActionItem | null {
  if (!activeThread) return null;
  const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
  return {
    kind: "action",
    value: "action:open-thread-artifacts",
    searchTerms: ["artifacts", "documents", "files", "linked", "plan", "report"],
    title: "Show artifacts",
    disabled: (activeThread.artifacts ?? []).length === 0,
    icon: <ThreadArtifactsTabIconFork className={ITEM_ICON_CLASS} />,
    run: async () => {
      useRightPanelStore.getState().open(threadRef, "thread-artifacts");
    },
  };
}
