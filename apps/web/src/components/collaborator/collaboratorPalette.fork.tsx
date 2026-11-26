// Fork-owned command-palette entry for sharing the active thread with a collaborator; upstream
// `CommandPalette.tsx` carries only marked hook lines pointing here.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { UserPlusIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  canShareWithCollaboratorFork,
  openCollaboratorShareDialog,
} from "./collaboratorShareDialogState.fork";

/** The thread menus' "Share with collaborator…", for a session that may share the active thread. */
export function buildShareWithCollaboratorActionItemFork(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
): CommandPaletteActionItem | null {
  if (activeThread == null) return null;
  if (!canShareWithCollaboratorFork(activeThread.environmentId)) return null;
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
