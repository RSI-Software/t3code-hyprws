import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem } from "@t3tools/contracts";

import {
  openInNewWindowRequest,
  requestDesktopWindow,
  supportsDesktopProjectWindows,
} from "../desktopWindows.fork";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";

/**
 * The legacy project menu's Open in New Window entry, on desktop only: one leaf for a
 * single-member project, a submenu of members otherwise, mirroring upstream's targeted items.
 */
export function legacyProjectWindowItemsFork(
  project: {
    readonly memberProjects: ReadonlyArray<SidebarProjectGroupMember>;
    readonly groupedProjectCount: number;
  },
  actionHandlers: Map<string, () => Promise<void> | void>,
  memberLabel: (member: SidebarProjectGroupMember, groupedProjectCount: number) => string,
): ContextMenuItem<string>[] {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!supportsDesktopProjectWindows(bridge)) return [];
  const label = "Open in New Window";
  const leaf = (member: SidebarProjectGroupMember): ContextMenuItem<string> => {
    const id = `open-window:${member.physicalProjectKey}`;
    actionHandlers.set(id, () =>
      requestDesktopWindow(
        bridge,
        openInNewWindowRequest(scopeProjectRef(member.environmentId, member.id)),
      ),
    );
    return { id, label: memberLabel(member, project.groupedProjectCount) };
  };
  const [single] = project.memberProjects;
  if (project.memberProjects.length === 1 && single) return [{ ...leaf(single), label }];
  return [{ id: "open-window:submenu", label, children: project.memberProjects.map(leaf) }];
}
