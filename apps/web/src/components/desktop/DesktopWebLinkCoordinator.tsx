import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef } from "react";

import { openFileInPreview, openUrlInPreview } from "../../browser/openFileInPreview";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useRightPanelStore } from "../../rightPanelStore";
import { assetEnvironment } from "../../state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Opens each web link or HTML file the OS hands T3 Code as the default browser
 * (macOS) in a new thread without a project, its browser panel maximized on the page.
 */
export function DesktopWebLinkCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironment?.environmentId ?? null);
  const queueRef = useRef(Promise.resolve());
  const webLinks = window.desktopBridge?.webLinks;
  const ready =
    webLinks !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null;

  const openLink = useEffectEvent(async (url: string) => {
    const environmentId = scratchEnvironmentId(primaryEnvironment?.environmentId ?? null);
    if (environmentId === null) return;
    const project = await openScratchProject(environmentId, "Could not open the link");
    if (!project) return;
    // Each link is its own thread, even before the user types in the last one.
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id), {
      fresh: true,
    });
    if (!opened) return;
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().requestMaximize(threadRef);
    // An HTML file is served from the environment, which runs on this machine.
    const result = url.startsWith("file:")
      ? httpBaseUrl === null
        ? null
        : await openFileInPreview({
            threadRef,
            filePath: decodeURIComponent(new URL(url).pathname),
            workspaceRoot: undefined,
            httpBaseUrl,
            createAssetUrl,
            openPreview,
          })
      : await openUrlInPreview({ threadRef, url, openPreview });
    if (result === null) return;
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open the link",
          description: error instanceof Error ? error.message : url,
        }),
      );
    }
  });

  useEffect(() => {
    if (!ready || webLinks === undefined) return;
    let subscribed = true;
    // Links open one at a time, so each gets its own thread in the order they came.
    const unsubscribe = webLinks.onOpen((url) => {
      queueRef.current = queueRef.current.then(() => openLink(url)).catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive links.
    queueMicrotask(() => {
      if (subscribed) void webLinks.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void webLinks.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [ready, webLinks]);

  return null;
}
