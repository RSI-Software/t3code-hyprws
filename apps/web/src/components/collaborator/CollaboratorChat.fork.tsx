// Fork-only (colleague-collab): the collaborator parts of a thread view. Messages waiting for the
// host sit at the end of the timeline, with Send and Dismiss for the host and Withdraw for their
// author. An `approve` collaborator's composer queues for the host instead of sending, and a thread
// its host stopped sharing stays readable with a locked composer.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CollaboratorMessageFork,
  type EnvironmentId,
  isCollaboratorGrantFork,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { HourglassIcon, UnplugIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentSession } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { guestBubbleClassName } from "../chat/guestMessageStyle";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const collaboratorMessages = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:collaborator:messages",
  tag: WS_METHODS.collaboratorSubscribeMessagesFork,
});

const submitMessageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "send message for approval",
  tag: WS_METHODS.collaboratorSubmitMessageFork,
});

const resolveMessageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "resolve collaborator message",
  tag: WS_METHODS.collaboratorResolveMessageFork,
});

const NO_MESSAGES: ReadonlyArray<CollaboratorMessageFork> = [];

/** The waiting messages this session may see; none from a server without collaborators. */
function useWaitingMessages(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  const served =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.collaboratorsFork === true;
  const { data } = useEnvironmentQuery(
    served ? collaboratorMessages({ environmentId, input: {} }) : null,
  );
  return data ?? NO_MESSAGES;
}

const FROZEN_BANNER: ComposerBannerStackItem = {
  id: "collaborator-frozen",
  variant: "warning",
  group: "environment",
  icon: <UnplugIcon />,
  title: "Disconnected from host",
  description: "The host stopped sharing this thread. You can still read and copy it.",
};

const APPROVAL_BANNER: ComposerBannerStackItem = {
  id: "collaborator-approval",
  variant: "info",
  group: "environment",
  icon: <HourglassIcon />,
  title: "The host sends your messages",
  description: "Each message waits for the host to send it to the agent.",
};

interface CollaboratorChatThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  /** Set only on a collaborator's copy of a shared thread. */
  readonly collaboratorFork?: "send" | "approve" | "frozen";
}

/** The thread view's collaborator overrides: its composer and the end of its timeline. */
export function useCollaboratorChatFork(
  thread: CollaboratorChatThread | null | undefined,
  draftTarget: ComposerThreadTarget,
  composerRef: RefObject<ChatComposerHandle | null>,
) {
  const prompt = () => composerRef.current?.getSendContext().prompt.trim() ?? "";
  const waiting = useWaitingMessages(thread?.environmentId ?? null).filter(
    (message) => message.threadId === thread?.id,
  );
  const submit = useAtomCommand(submitMessageCommand);
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const access = thread?.collaboratorFork;

  const submitForApproval = (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    const text = prompt();
    if (thread == null || text.length === 0) return;
    void submit({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, text },
    }).then((result) => {
      // Keep anything typed while the message was on its way.
      if (result._tag !== "Success" || prompt() !== text) return;
      clearComposerContent(draftTarget);
      composerRef.current?.resetCursorState();
    });
  };

  return {
    composer: (bannerItems: ReadonlyArray<ComposerBannerStackItem>) => {
      if (access === "frozen") {
        return {
          canOperateThread: false,
          sendDisabledReason: "The host stopped sharing this thread.",
          bannerItems: [FROZEN_BANNER, ...bannerItems],
        };
      }
      if (access === "approve") {
        // Text only: attachments would have to wait on the host's machine too.
        return {
          canOperateThread: false,
          onSend: submitForApproval,
          bannerItems: [APPROVAL_BANNER, ...bannerItems],
        };
      }
      return {};
    },
    footer: (footer: ReactNode) =>
      thread == null || waiting.length === 0
        ? {}
        : {
            footer: (
              <>
                {footer}
                <WaitingMessages
                  environmentId={thread.environmentId}
                  messages={waiting}
                  asAuthor={access !== undefined}
                />
              </>
            ),
          },
  };
}

function WaitingMessages({
  environmentId,
  messages,
  asAuthor,
}: {
  readonly environmentId: EnvironmentId;
  readonly messages: ReadonlyArray<CollaboratorMessageFork>;
  /** The collaborator sees their own, to withdraw; the host sends or dismisses. */
  readonly asAuthor: boolean;
}) {
  const resolve = useAtomCommand(resolveMessageCommand);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const run = async (message: CollaboratorMessageFork, decision: "send" | "dismiss") => {
    setBusyIds((ids) => new Set(ids).add(message.id));
    await resolve({
      environmentId,
      input: { threadId: message.threadId, messageId: message.id, decision },
    });
    setBusyIds((ids) => {
      const next = new Set(ids);
      next.delete(message.id);
      return next;
    });
  };

  return (
    <ol
      className="chat-content-lane flex flex-col gap-4 pb-4"
      aria-label={`${messages.length} collaborator message${messages.length === 1 ? "" : "s"} waiting`}
      aria-live="polite"
    >
      {messages.map((message) => {
        const busy = busyIds.has(message.id);
        return (
          <li key={message.id} className="flex flex-col items-end gap-1">
            <p className="me-1 text-2xs text-guest-foreground">
              {asAuthor ? "Waiting for the host" : `${message.name} · waiting for you`}
            </p>
            <div
              className={cn(
                "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl p-3 text-foreground",
                guestBubbleClassName(true),
              )}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {message.text}
              </p>
            </div>
            <div className="flex items-center gap-1 pe-1">
              {asAuthor ? (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busy}
                  onClick={() => void run(message, "dismiss")}
                >
                  Withdraw
                </Button>
              ) : (
                <>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={busy}
                    aria-label={`Dismiss message from ${message.name}`}
                    onClick={() => void run(message, "dismiss")}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="xs"
                    disabled={busy}
                    aria-label={`Send message from ${message.name}`}
                    onClick={() => void run(message, "send")}
                  >
                    Send
                  </Button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Tells the host about each new message a collaborator leaves for approval, wherever they are. */
function EnvironmentMessageToasts({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const asCollaborator =
    session._tag === "Success" && isCollaboratorGrantFork(session.value.permissions);
  const messages = useWaitingMessages(asCollaborator ? null : environmentId);
  const navigate = useNavigate();
  const route = resolveThreadRouteTarget(useParams({ strict: false }));
  const openThreadId = route?.kind === "server" ? route.threadRef.threadId : null;
  const seen = useRef<ReadonlySet<string> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- raises a toast, outside React, for each message that arrived since the last render.
  useEffect(() => {
    const previous = seen.current;
    seen.current = new Set(messages.map(({ id }) => id));
    // The first answer holds what was already waiting, not news.
    if (previous === null) return;
    for (const message of messages) {
      // The thread already open shows the message where the host answers it.
      if (previous.has(message.id) || message.threadId === openThreadId) continue;
      const toastId = toastManager.add({
        type: "info",
        title: `${message.name} sent a message for approval`,
        description: message.text.length > 120 ? `${message.text.slice(0, 120)}…` : message.text,
        actionProps: {
          children: "Review",
          onClick: () => {
            toastManager.close(toastId);
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, message.threadId)),
            });
          },
        },
      });
    }
  }, [messages, environmentId, navigate, openThreadId]);
  return null;
}

export function CollaboratorMessageToastsFork() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId }) => (
    <EnvironmentMessageToasts key={environmentId} environmentId={environmentId} />
  ));
}
