import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Thread, ThreadShell } from "../types";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  getStartedThreadModelChangeBlockReason,
  hasEnvironmentReconnectWarningGraceElapsed,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  nextTerminalFocusRequestId,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftPromotionNavigationTarget,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  resolveDraftHeroState,
  scheduleEnvironmentReconnectWarning,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  shouldAutoFocusComposerOnThreadChange,
  shouldDockDraftHeroForSubmission,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

describe("composer focus on thread change", () => {
  it("depends only on active thread identity, not terminal open state", () => {
    expect(shouldAutoFocusComposerOnThreadChange("thread-1")).toBe(true);
  });

  it("does not request focus without an active thread", () => {
    expect(shouldAutoFocusComposerOnThreadChange(null)).toBe(false);
  });
});

describe("terminal focus requests", () => {
  it("resets the outstanding request when the active thread changes", () => {
    expect(nextTerminalFocusRequestId("thread-1", "thread-2", 4)).toBe(0);
  });

  it("preserves the request while the active thread is unchanged", () => {
    expect(nextTerminalFocusRequestId("thread-1", "thread-1", 4)).toBe(4);
  });
});
