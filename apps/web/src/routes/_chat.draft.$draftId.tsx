import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import ChatView from "../components/ChatView";
import {
  resolveDraftPromotionNavigationTarget,
  threadHasStarted,
} from "../components/ChatView.logic";
import {
  DraftId,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import {
  isValidProjectRouteId,
  resolveProjectContentRedirect,
  resolveProjectRouteRef,
} from "../projectRoutes";
import { resolveThreadRouteFamily } from "../threadRoutes";
import { useThread, useThreadRefs } from "../state/entities";

export function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const routeParams = useParams({ strict: false });
  const rawDraftId = routeParams.draftId ?? "";
  const projectRouteRef = resolveProjectRouteRef(routeParams);
  const routeFamily = resolveThreadRouteFamily(routeParams);
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const threadRefs = useThreadRefs();
  const inferredThreadRef = draftSession
    ? (threadRefs.find(
        (ref) =>
          ref.environmentId === draftSession.environmentId &&
          ref.threadId === draftSession.threadId,
      ) ?? null)
    : null;
  const serverThreadRef = draftSession?.promotedTo ?? inferredThreadRef;
  const serverThread = useThread(serverThreadRef);
  const serverThreadStarted = threadHasStarted(serverThread);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(serverThreadRef);
  const canonicalThreadRef = resolveDraftPromotionNavigationTarget({
    serverThreadRef,
    serverThreadStarted,
    backgroundSubmissionPending,
  });
  const projectContentRedirect = projectRouteRef
    ? resolveProjectContentRedirect({
        routeRef: projectRouteRef,
        contentRef: draftSession
          ? {
              environmentId: draftSession.environmentId,
              projectId: draftSession.projectId,
            }
          : null,
        contentIdValid: isValidProjectRouteId(routeParams.draftId),
      })
    : null;

  useEffect(() => {
    if (!projectRouteRef || projectContentRedirect !== "project-index") {
      return;
    }
    void navigate({ ...routeFamily.index(), replace: true });
  }, [navigate, projectContentRedirect, projectRouteRef, routeFamily]);

  useEffect(() => {
    if (
      projectContentRedirect === "project-index" ||
      !inferredThreadRef ||
      draftSession?.promotedTo
    ) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef, projectContentRedirect]);

  useEffect(() => {
    if (!canonicalThreadRef || projectContentRedirect === "project-index") {
      return;
    }

    let cancelled = false;
    void waitForDraftHeroTransition().then(() => {
      if (cancelled) {
        return;
      }
      void navigate({ ...routeFamily.thread(canonicalThreadRef), replace: true });
    });

    return () => {
      cancelled = true;
    };
  }, [canonicalThreadRef, navigate, projectContentRedirect, routeFamily]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef || projectContentRedirect === "project-index") {
      return;
    }
    void navigate({ ...routeFamily.index(), replace: true });
  }, [
    canonicalThreadRef,
    draftSession,
    navigate,
    projectContentRedirect,
    projectRouteRef,
    routeFamily,
  ]);

  if (!draftSession || projectContentRedirect === "project-index") {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        forceExpandedMobileComposer
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
