import type {
  DesktopBridge,
  DesktopWindowRequest,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "./components/ui/toast";

export type DesktopProjectWindowBridge = DesktopBridge & {
  readonly requestWindow: NonNullable<DesktopBridge["requestWindow"]>;
};

/** Whether this client can open desktop windows: desktop only, never web or mobile. */
export function supportsDesktopProjectWindows(
  bridge: DesktopBridge | undefined,
): bridge is DesktopProjectWindowBridge {
  return typeof bridge?.requestWindow === "function";
}

function projectWindowRoute(ref: ScopedProjectRef): string {
  return `/project/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.projectId)}`;
}

export function projectThreadWindowRoute(ref: ScopedProjectRef, threadId: string): string {
  return `${projectWindowRoute(ref)}/thread/${encodeURIComponent(threadId)}`;
}

/** Open in New Window: a new window at `route`, its project filter seeded with `ref`. */
export function openInNewWindowRequest(
  ref: ScopedProjectRef,
  route: string = projectWindowRoute(ref),
): DesktopWindowRequest {
  return { kind: "open-in-new-window", route, seed: ref };
}

/** Sends a window request to the desktop shell, surfacing a failure as a toast. */
export function requestDesktopWindow(
  bridge: DesktopProjectWindowBridge,
  request: DesktopWindowRequest,
): void {
  void bridge.requestWindow(request).catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to open window",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
  });
}

/** The window commands, hidden from keybinding settings where no desktop window can open. */
export function isDesktopWindowCommand(command: string): boolean {
  return command === "window.new" || command === "window.openInNew";
}

/**
 * Runs a window keybinding. Returns whether `command` was one, so the caller
 * stops matching; `resolveProjectRef` names the Open in New Window target.
 */
export function runDesktopWindowCommandFork(
  command: string | null,
  event: KeyboardEvent,
  resolveProjectRef: () => ScopedProjectRef | null | undefined,
): boolean {
  if (command === null || !isDesktopWindowCommand(command)) return false;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!supportsDesktopProjectWindows(bridge)) return true;
  let request: DesktopWindowRequest = { kind: "new-window" };
  if (command === "window.openInNew") {
    const projectRef = resolveProjectRef();
    if (!projectRef) return true;
    request = openInNewWindowRequest(projectRef);
  }
  event.preventDefault();
  event.stopPropagation();
  requestDesktopWindow(bridge, request);
  return true;
}

/** Whether the running client can open a desktop window, read at menu-open time. */
export function canOpenDesktopWindow(): boolean {
  return typeof window !== "undefined" && supportsDesktopProjectWindows(window.desktopBridge);
}

/** A thread's Open in New Window: its thread route, the filter seeded with its project. */
export function openThreadInNewWindow(threadRef: ScopedThreadRef, projectId: ProjectId): void {
  if (typeof window === "undefined" || !supportsDesktopProjectWindows(window.desktopBridge)) return;
  const projectRef: ScopedProjectRef = { environmentId: threadRef.environmentId, projectId };
  requestDesktopWindow(
    window.desktopBridge,
    openInNewWindowRequest(projectRef, projectThreadWindowRoute(projectRef, threadRef.threadId)),
  );
}

// Lives with the route helpers, which read it without this module's toast import.
export { readDesktopProjectWindowRef } from "./projectRoutes";

export type SidebarBrandTarget =
  | { readonly kind: "hub"; readonly label: string }
  | { readonly kind: "project"; readonly label: string; readonly ref: ScopedProjectRef };

/**
 * Where the sidebar brand goes. A project window's brand lands on that
 * window's own project instead of the hub route.
 */
export function resolveSidebarBrandTarget(
  projectWindowRef: ScopedProjectRef | null,
): SidebarBrandTarget {
  return projectWindowRef === null
    ? { kind: "hub", label: "Go to threads" }
    : { kind: "project", label: "Go to project", ref: projectWindowRef };
}
