import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  buildProjectIndexRoute,
  isValidProjectRouteId,
  resolveProjectContentRedirect,
  resolveProjectRouteRef,
} from "../projectRoutes";
import {
  resolveThreadRouteFamily,
  resolveThreadRouteRef,
  resolveThreadRouteRenderState,
} from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useEnvironmentThreadRefs,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";

export function ChatThreadRouteView() {
  const navigate = useNavigate();
  const routeParams = useParams({ strict: false });
  const threadRef = resolveThreadRouteRef(routeParams);
  const projectRouteRef = resolveProjectRouteRef(routeParams);
  const routeFamily = resolveThreadRouteFamily(routeParams);
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const projectContentRedirect = projectRouteRef
    ? resolveProjectContentRedirect({
        routeRef: projectRouteRef,
        contentRef: serverThreadShell
          ? {
              environmentId: serverThreadShell.environmentId,
              projectId: serverThreadShell.projectId,
            }
          : null,
        contentIdValid: isValidProjectRouteId(routeParams.threadId),
      })
    : null;

  useEffect(() => {
    if (!projectRouteRef || projectContentRedirect !== "project-index") {
      return;
    }
    void navigate({ ...buildProjectIndexRoute(projectRouteRef), replace: true });
  }, [navigate, projectContentRedirect, projectRouteRef]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete || projectContentRedirect === "project-index") {
      return;
    }

    if (renderState === "missing" && (projectRouteRef !== null || environmentHasAnyThreads)) {
      void navigate({
        ...(projectRouteRef ? buildProjectIndexRoute(projectRouteRef) : routeFamily.index()),
        replace: true,
      });
    }
  }, [
    bootstrapComplete,
    environmentHasAnyThreads,
    navigate,
    projectContentRedirect,
    projectRouteRef,
    renderState,
    routeFamily,
    threadRef,
  ]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef || projectContentRedirect === "project-index") {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
        />
      ) : null}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
