// Fork-owned command-palette entry for forking the active thread; upstream `CommandPalette.tsx`
// carries only marked hook lines pointing here. It shares the thread menus' state and dispatch.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";

import {
  forkRefInFlightFork,
  forkThreadMenuStateFork,
  readForkProviderFork,
  useThreadForkDispatchFork,
} from "../hooks/useThreadActionMenu.fork";
import { useNowMinute } from "../hooks/useNowMinute";
import { readEnvironmentScope } from "../state/session";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

/**
 * "Fork thread" for the active thread, where its menus offer it: after its first run, for an
 * operator. Disabled while the thread is busy or a fork of it is in flight.
 */
export function useForkThreadActionItemFork(
  activeThread: EnvironmentThreadShell | null | undefined,
): CommandPaletteActionItem | null {
  const dispatch = useThreadForkDispatchFork();
  // The orchestrator refuses a busy fork anyway, so a minute's precision is enough here.
  const now = useNowMinute();
  if (activeThread == null) return null;
  const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
  if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return null;
  const state = forkThreadMenuStateFork(
    readForkProviderFork(threadRef, activeThread),
    forkRefInFlightFork(threadRef),
    activeThread,
    now,
  );
  if (state === null) return null;
  return {
    kind: "action",
    value: "action:fork-thread",
    searchTerms: ["fork", "branch", "copy", "duplicate", "thread", "conversation"],
    title: "Fork thread",
    disabled: state.busy || state.inFlight,
    icon: <GitForkIcon className={ITEM_ICON_CLASS} />,
    run: () => dispatch(threadRef),
  };
}
