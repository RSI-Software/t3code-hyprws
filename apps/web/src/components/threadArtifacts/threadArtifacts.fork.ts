// Fork-owned client logic for thread artifact links: the files an agent writes and links to a
// thread. Upstream modules reach this only through marked hook lines.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type RunId,
  type ScopedThreadRef,
  type ThreadArtifactLink,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import {
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { FileStackIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { isBrowserPreviewFile } from "~/browser/openFileInPreview";
import { useProactiveLinkedPanelFork } from "../../hooks/useProactiveLinkedPanel.fork";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "../../lib/utils";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { useProject, useQuietThreadShell, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { workspaceAssetResource } from "../files/filePreviewMode";

export const ThreadArtifactsTabIconFork = FileStackIcon;

/** The thread's checkout, where an in-workspace artifact opens editable rather than as a host file. */
export function useThreadWorkspaceRootFork(threadRef: ScopedThreadRef): string | null {
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
  );
  return thread?.worktreePath ?? project?.workspaceRoot ?? null;
}

export function openThreadArtifactFork(
  threadRef: ScopedThreadRef,
  link: ThreadArtifactLink,
  workspaceRoot: string | null,
) {
  const relative = workspaceRelativeFilePath(link.path, workspaceRoot);
  useRightPanelStore
    .getState()
    .openFile(threadRef, relative === null || relative === "." ? link.path : relative);
}

export function useUnlinkThreadArtifactFork() {
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  return (threadRef: ScopedThreadRef, path: string) =>
    dispatch({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.artifact.unlink",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        path,
      },
    });
}

/** The launcher props the Artifacts entry reads; spread into upstream `RightPanelTabsProps`. */
interface ThreadArtifactsLauncherPropsFork {
  onAddArtifacts?: () => void;
  artifactsAvailable?: boolean;
}

/** The Artifacts launcher entry, spread into upstream's surface action list. */
export const threadArtifactsSurfaceActionsFork = (props: ThreadArtifactsLauncherPropsFork) =>
  [
    {
      label: "Artifacts",
      description: "Documents the agent wrote and linked to this thread.",
      icon: FileStackIcon,
      shortcut: "A",
      available: props.artifactsAvailable === true,
      disabledReason: "Artifacts appear once the agent links a document to this thread.",
      unavailableHint: "Available once this thread links a document.",
      onClick: props.onAddArtifacts ?? (() => undefined),
    },
  ] as const;

const ARTIFACTS_SURFACE = { id: "thread-artifacts", kind: "thread-artifacts" } as const;

/** Launcher props, plus opening the Artifacts tab when the thread gains a link, like Linked issues. */
export function useThreadArtifactsPanelFork(
  threadRef: ScopedThreadRef | null,
  proactiveGate: { readonly runningTurnId: RunId | null; readonly allowed: boolean },
): ThreadArtifactsLauncherPropsFork {
  const thread = useThreadShell(threadRef);
  const artifactsAvailable = (thread?.artifacts?.length ?? 0) > 0;
  const onAddArtifacts = useStableCallback(() => {
    if (!threadRef || !artifactsAvailable) return;
    useRightPanelStore.getState().open(threadRef, "thread-artifacts");
  });
  useProactiveLinkedPanelFork(
    ARTIFACTS_SURFACE,
    threadRef,
    thread === null ? null : (thread.artifacts ?? []).map((link) => link.path),
    proactiveGate,
  );
  return { onAddArtifacts, artifactsAvailable };
}

/**
 * Folds a linked file's `updatedAt` into the file surface's workspace revision, so an open
 * artifact re-reads when the watcher sees it change. A host HTML, PDF, or image URL is pinned to
 * the file's inode and cached, so it is re-minted before the revision moves; an atomic rewrite
 * would otherwise 404. Video, audio, and documents already re-mint per revision.
 */
export function useThreadArtifactFileRevisionFork(props: {
  readonly surface: RightPanelSurface | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: unknown;
  readonly workspaceMutationId: string | null;
  readonly files: { readonly workspaceRoot: string | undefined };
}): { workspaceMutationId?: string } {
  const surface =
    props.surface?.kind === "file" && !props.surface.attachment ? props.surface : null;
  const cwd = props.files.workspaceRoot ?? "";
  const absolutePath = surface === null ? null : resolvePathLinkTarget(surface.relativePath, cwd);
  const thread = useQuietThreadShell(surface === null ? null : props.threadRef);
  const updatedAt =
    thread?.artifacts?.find((link) => link.path === absolutePath)?.updatedAt ?? null;
  const pinned =
    absolutePath !== null &&
    (isBrowserPreviewFile(absolutePath) ||
      (!isWorkspaceVideoPreviewPath(absolutePath) && isWorkspaceImagePreviewPath(absolutePath)));
  const refreshAssetUrl = useAssetUrlRefresh(
    props.environmentId,
    pinned
      ? workspaceAssetResource({
          kind: "workspace-file",
          threadRef: props.threadRef,
          draft: typeof props.composerDraftTarget === "string",
          workspaceRoot: cwd,
          absolutePath,
        })
      : null,
  );
  const reMintAssetUrl = useStableCallback(refreshAssetUrl);
  const [applied, setApplied] = useState({ path: absolutePath, updatedAt });
  // A newly opened file, or a link first seen, is current already; only a later change re-mints.
  if (applied.path !== absolutePath || (applied.updatedAt === null && updatedAt !== null)) {
    setApplied({ path: absolutePath, updatedAt });
  }
  const stale =
    pinned &&
    applied.path === absolutePath &&
    applied.updatedAt !== null &&
    updatedAt !== null &&
    updatedAt !== applied.updatedAt;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-mints the pinned preview's asset URL on the server before the frame or image reloads it
  useEffect(() => {
    if (!stale) return;
    let current = true;
    void reMintAssetUrl()
      .catch(() => null)
      .finally(() => {
        if (current) setApplied({ path: absolutePath, updatedAt });
      });
    return () => {
      current = false;
    };
  }, [absolutePath, reMintAssetUrl, stale, updatedAt]);
  const revision = stale ? applied.updatedAt : updatedAt;
  if (revision === null) return {};
  return { workspaceMutationId: `${props.workspaceMutationId ?? ""}|artifact:${revision}` };
}
