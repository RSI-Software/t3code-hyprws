import type { ScopedProjectRef } from "@t3tools/contracts";
import { createContext, use, type ReactNode } from "react";

/**
 * Ambient physical project scope for the sidebar tree.
 *
 * A project window pins its sidebar to one physical project. Carrying that as a prop meant
 * rewriting upstream's `AppSidebarLayout`, `Sidebar` and `LegacySidebar` signatures, so every
 * upstream edit to those declarations conflicted. The route provides the scope instead, and the
 * sidebars read it here — upstream keeps its own declarations and its own render tree.
 *
 * `null` is the hub: no physical scope, upstream behavior unchanged.
 */
const SidebarPhysicalScopeContext = createContext<ScopedProjectRef | null>(null);

export function SidebarPhysicalScopeProvider({
  projectRef,
  children,
}: {
  readonly projectRef: ScopedProjectRef | null;
  readonly children: ReactNode;
}) {
  return <SidebarPhysicalScopeContext value={projectRef}>{children}</SidebarPhysicalScopeContext>;
}

/** The project this sidebar is physically pinned to, or `null` in the hub window. */
export function useSidebarPhysicalScope(): ScopedProjectRef | null {
  return use(SidebarPhysicalScopeContext);
}
