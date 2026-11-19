// Fork-owned command-palette entry for sharing the active thread with a collaborator; upstream
// `CommandPalette.tsx` carries only marked hook lines pointing here.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { UserPlusIcon } from "lucide-react";

import { readEnvironmentScope } from "../../state/session";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { openCollaboratorShareDialog } from "./collaboratorShareDialogState.fork";

/** The thread menus' "Share with collaborator…", for an operator of the active thread. */
export function buildShareWithCollaboratorActionItemFork(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): CommandPaletteActionItem | null {
  if (activeThread == null) return null;
  if (!readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)) return null;
  const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
  return {
    kind: "action",
    value: "action:share-thread-with-collaborator",
    searchTerms: ["share", "collaborator", "colleague", "invite", "pair", "link", "teammate"],
    title: "Share with collaborator",
    icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openCollaboratorShareDialog(threadRef);
    },
  };
}
