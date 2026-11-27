// Fork-only (colleague-collab): the collaborator parts of a thread view. Waiting messages sit at
// the timeline's end with Send, Reply and Dismiss for the host and Withdraw for their author; a
// reply goes from the host's composer. An `approve` collaborator's composer queues for the host, a
// thread its host stopped sharing stays readable and locked, and a team thread shows no composer.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  selectEnvironmentQueryData,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type CollaboratorMessageFork,
  type CollaboratorTypingStateFork,
  type CollaboratorTypistFork,
  type EnvironmentId,
  isCollaboratorGrantFork,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { AsyncResult } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react";
import {
  ArrowUpIcon,
  Clock3Icon,
  EyeIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  ReplyIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery, useEnvironmentQuerySelector } from "~/state/query";
import { environmentSession } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { ComposerBannerStack, type ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { GuestMessageName } from "../chat/guestMessageStyle";
import { TimelineRowTimestamp } from "../chat/TimelineRowParts";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DismissedMessageFork, useWaitingListLabelFork } from "./CollaboratorMessageOutcome.fork";
import { collaboratorMessages } from "./useCollaboratorRequests.fork";
import { useColleagueOfflineBannerFork } from "./colleagueCopy.fork";
import { useColleagueInboxFork } from "./ColleagueInbox.fork";
import { useColleagueInboxVetoFork } from "./colleagueInbox.fork";
import {
  CollaboratorTypingFork,
  HOST_KEY,
  typingServedFork,
  typingSubscription,
} from "./CollaboratorTyping.fork";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import {
  QueuedForColleagueFork,
  submitMessageCommand,
  useColleagueOutboxFork,
} from "./colleagueOutbox.fork";
import { takeForceReplyFork } from "./sendMenu.fork";

const resolveMessageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "resolve collaborator message",
  tag: WS_METHODS.collaboratorResolveMessageFork,
});

const NO_MESSAGES: ReadonlyArray<CollaboratorMessageFork> = [];
// Only the shared flag, so a collaborator's typing does not re-render the chat view.
const selectShared = <E,>(result: AsyncResult.AsyncResult<CollaboratorTypingStateFork, E>) =>
  selectEnvironmentQueryData(result)?.shared === true;

/** The waiting messages this session may see; none from a server without collaborators. */
function useWaitingMessages(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  const served =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.collaboratorsFork === true;
  const { data } = useEnvironmentQuery(
    served ? collaboratorMessages({ environmentId, input: {} }) : null,
  );
  return (served && data) || NO_MESSAGES;
}

const FROZEN_BANNER = {
  id: "collaborator-frozen",
  variant: "warning",
  group: "environment",
  icon: <UnplugIcon />,
  title: msg("Disconnected from host"),
  description: msg("The host stopped sharing this thread. You can still read and copy it."),
} satisfies ComposerBannerStackItem;

const TEAM_BANNER = {
  id: "collaborator-team",
  variant: "info",
  group: "environment",
  icon: <EyeIcon />,
  title: msg("Read only"),
  description: msg("This thread is in a team project. You can read and copy it."),
} satisfies ComposerBannerStackItem;

const APPROVAL_BANNER = {
  id: "collaborator-approval",
  variant: "info",
  group: "environment",
  icon: <HourglassIcon />,
  title: msg("The host sends your messages"),
  description: msg("Each message waits for the host to send it to the agent."),
} satisfies ComposerBannerStackItem;

const localizedBanner = (
  banner: ComposerBannerStackItem & { readonly title: string; readonly description: string },
  messages: ReturnType<typeof useMessages>,
): ComposerBannerStackItem => ({
  ...banner,
  title: messages(banner.title),
  description: messages(banner.description),
});

interface CollaboratorChatThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  /** Set only on a collaborator's copy of a shared or team thread. */
  readonly collaboratorFork?: OrchestrationV2ThreadShell["collaboratorFork"];
}

/** The thread view's collaborator overrides: its composer, who is typing, and the end of its timeline. */
export function useCollaboratorChatFork(
  thread: CollaboratorChatThread | null | undefined,
  draftTarget: ComposerThreadTarget,
  composerRef: RefObject<ChatComposerHandle | null>,
  followingTimeline: boolean,
  scrollToEnd: (animated: boolean) => void,
  systemBanners: ReadonlyArray<ComposerBannerStackItem>,
) {
  const gt = useGT();
  const messages = useMessages();
  const prompt = () => composerRef.current?.getSendContext().prompt.trim() ?? "";
  const hasAttachments = () => {
    const context = composerRef.current?.getSendContext();
    return (context?.images.length ?? 0) + (context?.files.length ?? 0) > 0;
  };
  const waiting = useWaitingMessages(thread?.environmentId ?? null).filter(
    (message) => message.threadId === thread?.id,
  );
  const threadKey = thread?.id ?? null;
  const [replyingTo, setReplyingTo] = useState<CollaboratorMessageFork | null>(null);
  const waitingIds = waiting.map(({ id }) => id).join(",");
  const previousWaiting = useRef({ threadKey, waitingIds });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the timeline to a new waiting message, which joins the list footer the list does not follow
  useEffect(() => {
    const previous = previousWaiting.current;
    previousWaiting.current = { threadKey, waitingIds };
    if (previous.threadKey !== threadKey) return;
    const seen = new Set(previous.waitingIds.split(","));
    // The follow flag still holds the position from before the footer grew.
    if (followingTimeline && waitingIds.split(",").some((id) => id !== "" && !seen.has(id))) {
      scrollToEnd(true);
    }
  }, [threadKey, waitingIds, followingTimeline, scrollToEnd, previousWaiting]);
  const submit = useAtomCommand(submitMessageCommand);
  const outbox = useColleagueOutboxFork(thread);
  const resolve = useAtomCommand(resolveMessageCommand);
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const access = thread?.collaboratorFork;
  const configs = useServerConfigs();
  const served =
    thread != null &&
    typingServedFork(access) &&
    configs.get(thread.environmentId)?.environment.capabilities.collaboratorsFork === true;
  const shared = useEnvironmentQuerySelector(
    served
      ? typingSubscription({ environmentId: thread.environmentId, input: { threadId: thread.id } })
      : null,
    selectShared,
  );
  const hostOffline = useColleagueOfflineBannerFork(
    access === undefined ? null : (thread?.environmentId ?? null),
    access === undefined ? null : (thread?.id ?? null),
  );
  const browsing = useColleagueInboxFork().browsing;
  const browsingName =
    browsing !== null && browsing.environmentId === thread?.environmentId ? browsing.name : null;
  const replying = access === undefined && replyingTo?.threadId === thread?.id ? replyingTo : null;
  // Its author may withdraw it, or another tab answer it; the draft must not then reach the agent.
  const replyGone =
    replying !== null &&
    !waiting.some((message) => message.id === replying.id && message.outcome === undefined);

  /** Hands the composer's text to `deliver`, clearing it once that lands. Text only. */
  const sendText =
    (
      deliver: (text: string) => Promise<AtomCommandResult<void, unknown>> | null,
      copy: {
        readonly attachmentsTitle: string;
        readonly attachmentsDescription: string;
        readonly failure: string;
      },
      sent?: () => void,
    ) =>
    (event?: { preventDefault: () => void }) => {
      event?.preventDefault();
      const text = prompt();
      if (thread == null || text.length === 0) return;
      if (hasAttachments()) {
        toastManager.add({
          type: "warning",
          title: copy.attachmentsTitle,
          description: copy.attachmentsDescription,
        });
        return;
      }
      void deliver(text)?.then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: copy.failure,
            description:
              collaboratorErrorTextFork(squashAtomCommandFailure(result)) ??
              gt("Could not deliver the message."),
          });
        }
        if (result._tag !== "Success") return;
        sent?.();
        // Keep anything typed while the message was on its way.
        if (prompt() !== text) return;
        clearComposerContent(draftTarget);
        composerRef.current?.resetCursorState();
      });
    };
  const submitForApproval = (event?: { preventDefault: () => void }) => {
    const forced = takeForceReplyFork(composerTargetKey(draftTarget));
    sendText(
      (text) =>
        thread == null
          ? null
          : submit({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, text, ...(forced ? { forceReplyFork: true } : {}) },
            }),
      {
        attachmentsTitle: gt("Only text waits for the host"),
        attachmentsDescription: gt("Remove the attachments to send this message for approval."),
        failure: gt("Could not send for approval"),
      },
    )(event);
  };
  const queueOffline = sendText(outbox.queue, {
    attachmentsTitle: gt("Only text waits for {name}", { name: outbox.name }),
    attachmentsDescription: gt("Remove the attachments to queue this message."),
    failure: gt("Could not queue the message"),
  });
  const editQueued = async (message: { readonly id: string; readonly text: string }) => {
    if (!(await outbox.unqueue(message.id))) return;
    composerRef.current?.insertTextAtEnd(message.text, { ensureLeadingBoundary: true });
    composerRef.current?.focusAtEnd();
  };

  const sendReply = (message: CollaboratorMessageFork) =>
    sendText(
      (text) =>
        thread == null
          ? null
          : resolve({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, messageId: message.id, decision: "reply", text },
            }),
      {
        attachmentsTitle: gt("Only text goes in a reply"),
        attachmentsDescription: gt("Remove the attachments to send this reply."),
        failure: gt("Could not send the reply"),
      },
      // A newer reply target chosen while this one was on its way stays.
      () => setReplyingTo((current) => (current?.id === message.id ? null : current)),
    );

  const startReply = (message: CollaboratorMessageFork) => {
    setReplyingTo(message);
    composerRef.current?.focusAtEnd();
  };

  return {
    typing:
      thread == null ? null : access === "read" ? (
        // A team thread shows no composer: this slot sits just above it, so it hides its next sibling.
        <div className="[&+div]:hidden">
          <ComposerBannerStack
            items={[
              ...hostOffline(systemBanners).filter((item) => item.group === "environment"),
              localizedBanner(TEAM_BANNER, messages),
            ]}
            detached
          />
        </div>
      ) : (
        <CollaboratorTypingFork thread={thread} draftTarget={draftTarget} />
      ),
    composer: (items: ReadonlyArray<ComposerBannerStackItem>) => {
      const bannerItems = hostOffline(items);
      if (browsingName !== null) {
        const readOnly = gt("Read-only here. Switch to My inbox to reply.");
        return {
          canOperateThread: false,
          sendDisabledReason: readOnly,
          bannerItems: [
            {
              id: "colleague-inbox",
              variant: "info",
              group: "environment",
              icon: <EyeIcon />,
              title: gt("{name}'s inbox", { name: browsingName }),
              description: readOnly,
            } satisfies ComposerBannerStackItem,
            ...bannerItems,
          ],
        };
      }
      if (access === "frozen") {
        return {
          canOperateThread: false,
          sendDisabledReason: gt("The host stopped sharing this thread."),
          bannerItems: [localizedBanner(FROZEN_BANNER, messages), ...bannerItems],
        };
      }
      if (access === "read") {
        return {
          canOperateThread: false,
          sendDisabledReason: gt("Team project threads are read only."),
        };
      }
      if (replying !== null) {
        const gone = gt("{name}'s message is no longer waiting", { name: replying.name });
        return {
          onSend: sendReply(replying),
          ...(replyGone ? { sendDisabledReason: gone } : {}),
          bannerItems: [
            {
              id: "collaborator-reply",
              variant: replyGone ? "warning" : "info",
              group: "attention",
              icon: <ReplyIcon />,
              title: replyGone ? gone : gt("Replying to {name}", { name: replying.name }),
              description: (
                <span className="line-clamp-2">{assistantCitationsToPlainText(replying.text)}</span>
              ),
              dismissLabel: gt("Cancel reply"),
              onDismiss: () => setReplyingTo(null),
            } satisfies ComposerBannerStackItem,
            ...bannerItems,
          ],
        };
      }
      // While a saved colleague's machine is away, a send waits here for it. The reconnect
      // banner stays; the composer's gates lift, and its submit skips the host's session scopes,
      // which a reload leaves unread until they return.
      const offline = outbox.queues
        ? {
            queueSendFork: (event?: { preventDefault: () => void }) => {
              queueOffline(event);
              return true;
            },
            environmentUnavailable: null,
            canOperateThread: true,
            sendDisabledReason: null,
          }
        : { onSend: submitForApproval };
      if (outbox.queues && access === "send") return { ...offline, bannerItems };
      if (access === "approve") {
        // The server refuses an approve collaborator's interrupt, so no Stop button.
        return {
          ...offline,
          canInterrupt: false,
          // The offline queue keeps text only, so "Ask the agent" waits for the host to return.
          ...(outbox.queues ? {} : { sendMenuFork: { askAgent: true } }),
          bannerItems: [localizedBanner(APPROVAL_BANNER, messages), ...bannerItems],
        };
      }
      const sendMenu = shared ? { sendMenuFork: { askAgent: true } } : {};
      return access === undefined ? sendMenu : { ...sendMenu, bannerItems };
    },
    footer: (footer: ReactNode) =>
      thread == null || (waiting.length === 0 && outbox.queued.length === 0)
        ? {}
        : {
            footer: (
              <>
                {footer}
                {waiting.length === 0 ? null : (
                  <WaitingMessages
                    environmentId={thread.environmentId}
                    messages={waiting}
                    asAuthor={access !== undefined}
                    replyingTo={replying?.id ?? null}
                    onReply={startReply}
                  />
                )}
                {outbox.queued.length === 0 ? null : (
                  <QueuedForColleagueFork
                    environmentId={thread.environmentId}
                    messages={outbox.queued}
                    name={outbox.name}
                    online={outbox.online}
                    held={outbox.held}
                    onEdit={(message) => void editQueued(message)}
                    onWithdraw={(message) => void outbox.unqueue(message.id)}
                  />
                )}
              </>
            ),
          },
  };
}

/** Waiting messages wear the queued-message look: a dashed bubble, then a row of quiet controls. */
function WaitingMessages({
  environmentId,
  messages,
  asAuthor,
  replyingTo,
  onReply,
}: {
  readonly environmentId: EnvironmentId;
  readonly messages: ReadonlyArray<CollaboratorMessageFork>;
  /** The collaborator sees their own, to withdraw; the host sends, replies or dismisses. */
  readonly asAuthor: boolean;
  readonly replyingTo: string | null;
  readonly onReply: (message: CollaboratorMessageFork) => void;
}) {
  const gt = useGT();
  const timestampFormat = useEnvironmentSettings(environmentId).timestampFormat;
  const resolve = useAtomCommand(resolveMessageCommand);
  const label = useWaitingListLabelFork(messages);
  const readOnly = useColleagueInboxVetoFork(environmentId, AuthOrchestrationOperateScope);
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
    <section
      aria-label={label}
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col pb-4"
    >
      <ol className="flex flex-col items-end gap-3" aria-live="polite">
        {messages.map((message) => {
          const busy = readOnly || busyIds.has(message.id);
          if (message.outcome === "dismissed") {
            return (
              <DismissedMessageFork
                key={message.id}
                message={message}
                timestampFormat={timestampFormat}
                busy={busy}
                onClear={() => void run(message, "dismiss")}
              />
            );
          }
          return (
            <li key={message.id} className="group/queued flex w-full flex-col items-end gap-1">
              {asAuthor ? null : <GuestMessageName name={message.name} />}
              <div className="flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed border-guest/50 px-3 py-2 text-muted-foreground text-sm">
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {assistantCitationsToPlainText(message.text)}
                </p>
              </div>
              <div className="flex items-center gap-0.5 pe-1 text-muted-foreground text-xs">
                {message.forceReplyFork ? (
                  <span className="flex items-center gap-1 px-1">
                    <MessageCircleQuestionIcon aria-hidden className="size-3" />
                    {gt("Asks the agent")}
                  </span>
                ) : null}
                <span className="me-1 flex items-center px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
                  <TimelineRowTimestamp
                    createdAt={message.submittedAt}
                    timestampFormat={timestampFormat}
                    alwaysVisible
                  />
                </span>
                {asAuthor ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    {gt("Waiting for the host")}
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={busy}
                        aria-label={gt("Send {name}'s message", { name: message.name })}
                        onClick={() => void run(message, "send")}
                      >
                        <ArrowUpIcon />
                        {gt("Send")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipPopup>{gt("Send to the agent")}</TooltipPopup>
                  </Tooltip>
                )}
                {asAuthor ? null : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={busy}
                        aria-pressed={replyingTo === message.id}
                        aria-label={gt("Reply to {name}", { name: message.name })}
                        onClick={() => onReply(message)}
                      >
                        <ReplyIcon />
                        {gt("Reply", { $context: "verb, answer a person's message" })}
                      </Button>
                    </TooltipTrigger>
                    <TooltipPopup>
                      {gt("Answer {name} in the thread", { name: message.name })}
                    </TooltipPopup>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        disabled={busy}
                        aria-label={
                          asAuthor
                            ? gt("Withdraw message")
                            : gt("Dismiss {name}'s message", { name: message.name })
                        }
                        onClick={() => void run(message, "dismiss")}
                      />
                    }
                  >
                    <XIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{asAuthor ? gt("Withdraw") : gt("Dismiss")}</TooltipPopup>
                </Tooltip>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Tells the host about each new message a collaborator leaves for approval, wherever they are. */
function EnvironmentMessageToasts({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
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
      const text = assistantCitationsToPlainText(message.text);
      const toastId = toastManager.add({
        type: "info",
        title: gt("{name} sent a message for approval", { name: message.name }),
        description: text.length > 120 ? `${text.slice(0, 120)}…` : text,
        actionProps: {
          children: gt("Review"),
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
  }, [messages, environmentId, navigate, openThreadId, gt]);
  return null;
}

export function CollaboratorMessageToastsFork() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId }) => (
    <EnvironmentMessageToasts key={environmentId} environmentId={environmentId} />
  ));
}

const NO_TYPISTS: ReadonlyArray<CollaboratorTypistFork> = [];

/** Who else cites what in a shared thread, so the transcript can mark it as theirs. */
export function useCollaboratorCitationsFork(threadRef: ScopedThreadRef | null) {
  const thread = useQuietThreadShell(threadRef);
  const configs = useServerConfigs();
  const served =
    threadRef !== null &&
    configs.get(threadRef.environmentId)?.environment.capabilities.collaboratorsFork === true &&
    typingServedFork(thread?.collaboratorFork);
  const typing = useEnvironmentQuery(
    served
      ? typingSubscription({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  ).data;
  const typists = typing?.typists ?? NO_TYPISTS;
  const waiting = useWaitingMessages(threadRef?.environmentId ?? null);
  const asCollaborator = thread?.collaboratorFork !== undefined;
  return {
    /** Who wrote an unattributed message: you as the host, else the host. */
    hostName: asCollaborator ? HOST_KEY : null,
    /** A collaborator's own name, which their sent messages carry; null for the host. */
    you: typing?.you ?? null,
    /** Everyone in the order they joined the thread, the host first, which orders their hues. */
    people: [HOST_KEY, ...(typing?.people ?? [])],
    peers: typists.flatMap(({ subject, device, name, draft }) =>
      draft?.citations?.length
        ? [
            {
              key: `${subject}:${device ?? ""}`,
              owner: name ?? HOST_KEY,
              citations: draft.citations,
            },
          ]
        : [],
    ),
    // A collaborator sees only their own waiting messages.
    waiting: waiting.flatMap((message) =>
      message.threadId === threadRef?.threadId
        ? [
            {
              id: `waiting:${message.id}`,
              text: message.text,
              owner: asCollaborator ? null : message.name,
            },
          ]
        : [],
    ),
  };
}
