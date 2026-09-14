// Fork-owned right-panel Agents surface logic (RSI-Software/t3code-hyprws#674).
// The openAgents store member's body was woven into rightPanelStore.ts; the
// upstream file keeps only the marked interface declaration and one marked
// call. Types arrive as structural mirrors so nothing runtime-shared cycles
// back through the upstream module.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

type ByThreadKey = Record<string, ThreadRightPanelState>;
type ThreadUpdater = (current: ThreadRightPanelState) => ThreadRightPanelState;

const replaceSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
): ThreadRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
    : [...current.surfaces, surface],
  activeSurfaceId: surface.id,
});

/** The store slice's `openAgents` member, composed with the store's own helpers. */
export const createOpenAgents =
  (deps: {
    set: (partial: (state: { byThreadKey: ByThreadKey }) => { byThreadKey: ByThreadKey }) => void;
    updateThread: (
      byThreadKey: ByThreadKey,
      threadKey: string,
      updater: ThreadUpdater,
    ) => ByThreadKey;
  }): ((
    ref: ScopedThreadRef,
    target?:
      | {
          readonly selectedAgentId?: string | null;
          readonly rosterFocusAgentId?: string | null;
        }
      | undefined,
  ) => void) =>
  (ref, target) =>
    deps.set((state) => ({
      byThreadKey: deps.updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
        replaceSurface(current, {
          id: "agents",
          kind: "agents",
          selectedAgentId: target?.selectedAgentId ?? null,
          rosterFocusAgentId: target?.rosterFocusAgentId ?? null,
        }),
      ),
    }));
