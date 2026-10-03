import { useLayoutEffect, useRef } from "react";
import type { ProjectScript, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  armDevAppPreviewHandoff,
  DevAppPreviewHandoffCancelledError,
  DevAppPreviewInvocationLifecycle,
  devAppPreviewActionBlockReason,
  devAppPreviewActionCommandForRuntime,
  isDevAppPreviewActionCommand,
  type DevAppPreviewHandoff,
  type DevAppPreviewInvocationLease,
} from "../../browser/devAppPreviewHandoff";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { readPreparedConnection } from "../../state/session";
import type { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";

export type DevAppPreviewScopeFork = {
  lifecycle: DevAppPreviewInvocationLifecycle;
  handoffs: Set<DevAppPreviewHandoff>;
};

export function useDevAppPreviewFork({
  threadRef,
  openPreview,
  onError,
}: {
  threadRef: ScopedThreadRef | null;
  openPreview: Parameters<typeof openUrlInPreview>[0]["openPreview"];
  onError: (message: string) => void;
}) {
  const scopeRef = useRef<DevAppPreviewScopeFork | null>(null);
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  useLayoutEffect(() => {
    if (!environmentId || !threadId) return;
    const scope: DevAppPreviewScopeFork = {
      lifecycle: new DevAppPreviewInvocationLifecycle(),
      handoffs: new Set(),
    };
    scopeRef.current = scope;
    return () => {
      scopeRef.current = null;
      scope.lifecycle.dispose();
      for (const handoff of scope.handoffs) handoff.cancel();
      scope.handoffs.clear();
    };
  }, [environmentId, threadId]);

  const actions = () =>
    createDevAppPreviewActionsFork({
      getScope: () => scopeRef.current,
      threadRef,
      openPreview,
      onError,
    });
  type Actions = ReturnType<typeof createDevAppPreviewActionsFork>;
  return {
    begin: (command: string) => actions().begin(command),
    launchEnvironment: (...args: Parameters<Actions["launchEnvironment"]>) =>
      actions().launchEnvironment(...args),
    write: (...args: Parameters<Actions["write"]>) => actions().write(...args),
  };
}

export function createDevAppPreviewActionsFork({
  getScope,
  threadRef,
  openPreview,
  onError,
}: {
  getScope: () => DevAppPreviewScopeFork | null;
  threadRef: ScopedThreadRef | null;
  openPreview: Parameters<typeof openUrlInPreview>[0]["openPreview"];
  onError: (message: string) => void;
}) {
  return {
    launchEnvironment(env: Record<string, string> | undefined, projectId: string) {
      return { extraEnv: { ...env, T3CODE_PROJECT_ID: projectId } };
    },
    begin(command: string) {
      const scope = getScope();
      if (!threadRef || !scope) return null;
      const reason = devAppPreviewActionBlockReason(
        command,
        readPreparedConnection(threadRef.environmentId),
      );
      if (reason) {
        onError(reason);
        return null;
      }
      return scope.lifecycle.begin();
    },
    async write(
      command: string,
      terminalId: string,
      invocation: DevAppPreviewInvocationLease,
      write: ReturnType<typeof useThreadTerminalActions>["writeToTerminal"],
      preserveHistory: boolean,
      scriptPreview?: Pick<ProjectScript, "autoOpenPreview" | "previewUrl">,
    ) {
      if (!isDevAppPreviewActionCommand(command)) return false;
      const scope = getScope();
      if (!scope || !threadRef || !invocation.isActive()) return true;
      const previewSupported = isPreviewSupportedInRuntime();
      let handoff: DevAppPreviewHandoff | null = null;
      const cancel = () => {
        handoff?.cancel();
        if (handoff) scope.handoffs.delete(handoff);
        invocation.cancel();
      };
      if (previewSupported) {
        handoff = armDevAppPreviewHandoff({
          environmentId: threadRef.environmentId,
          terminal: { threadId: threadRef.threadId, terminalId },
          onPreviewUrl: async (url) => {
            if (!handoff || !scope.handoffs.delete(handoff)) return;
            const result = await openUrlInPreview({ threadRef, url, openPreview });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              onError(
                error instanceof Error ? error.message : "Failed to open the dev app preview.",
              );
            }
          },
          onError: (message) => {
            if (handoff) scope.handoffs.delete(handoff);
            onError(message);
          },
        });
        scope.handoffs.add(handoff);
        try {
          await handoff.ready;
        } catch (error: unknown) {
          cancel();
          if (!(error instanceof DevAppPreviewHandoffCancelledError)) {
            onError(
              error instanceof Error ? error.message : "Failed to watch for the dev app preview.",
            );
          }
          return true;
        }
      }
      if (!invocation.isActive() || (handoff !== null && !handoff.isActive())) {
        cancel();
        return true;
      }
      const runtimeCommand = devAppPreviewActionCommandForRuntime(command, previewSupported);
      const result = await write(
        terminalId,
        preserveHistory ? `${runtimeCommand}\r` : projectScriptTerminalInput(runtimeCommand),
      );
      if (!invocation.isActive()) {
        cancel();
        return true;
      }
      if (!result || result._tag === "Failure") cancel();
      if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        onError(error instanceof Error ? error.message : "Failed to run the dev app.");
      }
      if (
        result?._tag === "Success" &&
        previewSupported &&
        scriptPreview?.autoOpenPreview &&
        scriptPreview.previewUrl
      ) {
        const previewResult = await openUrlInPreview({
          threadRef,
          url: resolveDiscoveredServerUrl(threadRef.environmentId, scriptPreview.previewUrl),
          openPreview,
        });
        if (previewResult._tag === "Failure" && !isAtomCommandInterrupted(previewResult)) {
          const error = squashAtomCommandFailure(previewResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not open preview",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        }
      }
      invocation.cancel();
      return true;
    },
  };
}
