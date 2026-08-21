import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { resolveThreadRouteFamily } from "../threadRoutes";
import { useThread, useThreadRefs } from "../state/entities";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const routeFamily = Route.useParams({
    select: (params) => resolveThreadRouteFamily(params),
  });
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

  useEffect(() => {
    if (!inferredThreadRef || draftSession?.promotedTo) {
      return;
    }
    markPromotedDraftThreadByRef(inferredThreadRef);
  }, [draftSession?.promotedTo, inferredThreadRef]);

  useEffect(() => {
    if (!canonicalThreadRef) {
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
  }, [canonicalThreadRef, navigate, routeFamily]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ ...routeFamily.index(), replace: true });
  }, [canonicalThreadRef, draftSession, navigate, routeFamily]);

  if (!draftSession) {
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
