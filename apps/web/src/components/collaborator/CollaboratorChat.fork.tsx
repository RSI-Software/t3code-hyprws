// Fork-only (colleague-collab): the collaborator parts of a thread view. Messages waiting for the
// host sit at the end of the timeline like queued ones, with Send and Dismiss for the host and
// Withdraw for their author. An `approve` collaborator's composer queues for the host instead of sending, and a thread
// its host stopped sharing stays readable with a locked composer.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CollaboratorMessageFork,
  type CollaboratorTypistFork,
  type EnvironmentId,
  isCollaboratorGrantFork,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  BotIcon,
  Clock3Icon,
  HourglassIcon,
  UnplugIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  type ComposerThreadTarget,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { environmentSession } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { TimelineRowTimestamp } from "../chat/TimelineRowParts";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CollaboratorTypingFork, HOST_KEY, typingSubscription } from "./CollaboratorTyping.fork";

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
  return (served && data) || NO_MESSAGES;
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

/** Spike RSI-711: a message reaches the agent only when it says `@agent`. */
export const AGENT_MENTION_FORK = /(^|\s)@agent\b/i;

/** Spike RSI-711: whether anyone else sees this thread, so `@agent` decides what reaches the agent. */
export function useThreadSharedFork(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const configs = useServerConfigs();
  const served =
    environmentId !== null &&
    threadId !== null &&
    configs.get(environmentId)?.environment.capabilities.collaboratorsFork === true;
  const state = useEnvironmentQuery(
    served ? typingSubscription({ environmentId, input: { threadId } }) : null,
  ).data;
  return { shared: state?.shared === true, people: [HOST_KEY, ...(state?.people ?? [])] };
}

const PEOPLE_BANNER: ComposerBannerStackItem = {
  id: "people-only",
  variant: "info",
  group: "environment",
  icon: <UsersIcon />,
  title: "Only people in this thread see this",
  description: "Write @agent to send it to the agent.",
};

const AGENT_BANNER: ComposerBannerStackItem = {
  id: "people-only",
  variant: "info",
  group: "environment",
  icon: <BotIcon />,
  title: "This goes to the agent",
  description: "It reads the people-only lines since its last turn as context.",
};

interface CollaboratorChatThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  /** Set only on a collaborator's copy of a shared thread. */
  readonly collaboratorFork?: "send" | "approve" | "frozen";
}

/** The thread view's collaborator overrides: its composer, who is typing, and the end of its timeline. */
export function useCollaboratorChatFork(
  thread: CollaboratorChatThread | null | undefined,
  draftTarget: ComposerThreadTarget,
  composerRef: RefObject<ChatComposerHandle | null>,
  followingTimeline: boolean,
  scrollToEnd: (animated: boolean) => void,
) {
  const prompt = () => composerRef.current?.getSendContext().prompt.trim() ?? "";
  const hasAttachments = () => {
    const context = composerRef.current?.getSendContext();
    return (context?.images.length ?? 0) + (context?.files.length ?? 0) > 0;
  };
  const waiting = useWaitingMessages(thread?.environmentId ?? null).filter(
    (message) => message.threadId === thread?.id,
  );
  const threadKey = thread?.id ?? null;
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
  }, [threadKey, waitingIds, followingTimeline, scrollToEnd]);
  const submit = useAtomCommand(submitMessageCommand);
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const access = thread?.collaboratorFork;
  const { shared } = useThreadSharedFork(thread?.environmentId ?? null, thread?.id ?? null);
  const draftPrompt = useComposerThreadDraft(draftTarget).prompt;
  const agentBound = AGENT_MENTION_FORK.test(draftPrompt);

  const postPeopleLine = (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    const text = prompt();
    if (thread == null || text.length === 0) return;
    void submit({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, text, peopleOnly: true },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not post the line",
          description: formatEnvironmentQueryError(result.cause),
        });
      }
      if (result._tag !== "Success" || prompt() !== text) return;
      clearComposerContent(draftTarget);
      composerRef.current?.resetCursorState();
    });
  };

  const submitForApproval = (event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    const text = prompt();
    if (thread == null || text.length === 0) return;
    if (hasAttachments()) {
      toastManager.add({
        type: "warning",
        title: "Only text waits for the host",
        description: "Remove the attachments to send this message for approval.",
      });
      return;
    }
    void submit({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, text },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not send for approval",
          description: formatEnvironmentQueryError(result.cause),
        });
      }
      // Keep anything typed while the message was on its way.
      if (result._tag !== "Success" || prompt() !== text) return;
      clearComposerContent(draftTarget);
      composerRef.current?.resetCursorState();
    });
  };

  return {
    typing:
      thread == null ? null : <CollaboratorTypingFork thread={thread} draftTarget={draftTarget} />,
    composer: (
      bannerItems: ReadonlyArray<ComposerBannerStackItem>,
      defaultSend?: (event?: { preventDefault: () => void }, ...rest: never[]) => void,
    ) => {
      if (shared && access !== "frozen") {
        const sendToAgent = access === "approve" ? submitForApproval : defaultSend;
        return {
          onSend: (event?: { preventDefault: () => void }) =>
            AGENT_MENTION_FORK.test(prompt()) ? sendToAgent?.(event) : postPeopleLine(event),
          ...(access === "approve" ? { canInterrupt: false } : {}),
          bannerItems: [
            agentBound ? AGENT_BANNER : PEOPLE_BANNER,
            ...(access === "approve" && agentBound ? [APPROVAL_BANNER] : []),
            ...bannerItems,
          ],
        };
      }
      if (access === "frozen") {
        return {
          canOperateThread: false,
          sendDisabledReason: "The host stopped sharing this thread.",
          bannerItems: [FROZEN_BANNER, ...bannerItems],
        };
      }
      if (access === "approve") {
        // The server refuses an approve collaborator's interrupt, so no Stop button.
        return {
          onSend: submitForApproval,
          canInterrupt: false,
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
                <PeopleLinesFork
                  lines={waiting.flatMap((message) =>
                    message.kind === "people"
                      ? [{ name: message.name, text: message.text, at: message.submittedAt }]
                      : [],
                  )}
                  environmentId={thread.environmentId}
                  threadId={thread.id}
                  live
                />
                {waiting.some((message) => message.kind !== "people") ? (
                  <WaitingMessages
                    environmentId={thread.environmentId}
                    messages={waiting.filter((message) => message.kind !== "people")}
                    asAuthor={access !== undefined}
                  />
                ) : null}
              </>
            ),
          },
  };
}

/**
 * Spike RSI-711: lines between people, never sent to the agent. Left-aligned, no bubble, each
 * speaker in their colour, so they read as talk beside the agent's work, not prompts.
 */
export function PeopleLinesFork({
  lines,
  environmentId,
  threadId,
  live = false,
}: {
  readonly lines: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
    readonly at: string;
  }>;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** Still waiting for an `@agent` message; folded lines sit above the one that carried them. */
  readonly live?: boolean;
}) {
  const { people } = useThreadSharedFork(environmentId, threadId);
  if (lines.length === 0) return null;
  return (
    <section
      aria-label="People-only lines"
      className={`relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-1 ${live ? "pb-4" : "pb-1"}`}
    >
      <p className="flex items-center gap-1 text-2xs text-muted-foreground/80">
        <UsersIcon aria-hidden className="size-3" />
        {live
          ? "Between people · the agent reads these at the next @agent"
          : "Between people · sent to the agent as context"}
      </p>
      <ol className="flex flex-col gap-1 border-s-2 border-border ps-3">
        {lines.map((line, index) => {
          const hue = people.indexOf(line.name);
          return (
            <li key={`${line.at}:${index}`} className="text-sm leading-snug">
              <span
                className="me-1.5 font-medium"
                style={hue >= 0 ? { color: `var(--annotation-peer-${hue % 6})` } : undefined}
              >
                {line.name === "" ? "Host" : line.name}
              </span>
              <span className="whitespace-pre-wrap wrap-anywhere text-foreground/90">
                {line.text}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Waiting messages wear the queued-message look: a dashed bubble, then a row of quiet controls. */
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
  const timestampFormat = useEnvironmentSettings(environmentId).timestampFormat;
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
    <section
      aria-label={`${messages.length} message${messages.length === 1 ? "" : "s"} waiting for the host`}
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col pb-4"
    >
      <ol className="flex flex-col items-end gap-3" aria-live="polite">
        {messages.map((message) => {
          const busy = busyIds.has(message.id);
          return (
            <li key={message.id} className="group/queued flex w-full flex-col items-end gap-1">
              {asAuthor ? null : (
                <p className="me-1 text-2xs text-guest-foreground">
                  {message.name}
                  <span className="sr-only"> (collaborator)</span>
                </p>
              )}
              <div className="flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed border-guest/50 px-3 py-2 text-muted-foreground text-sm">
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {assistantCitationsToPlainText(message.text)}
                </p>
              </div>
              <div className="flex items-center gap-0.5 pe-1 text-muted-foreground text-xs">
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
                    Waiting for the host
                  </span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={busy}
                        aria-label={`Send ${message.name}'s message`}
                        onClick={() => void run(message, "send")}
                      >
                        <ArrowUpIcon />
                        Send
                      </Button>
                    </TooltipTrigger>
                    <TooltipPopup>Send to the agent</TooltipPopup>
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
                          asAuthor ? "Withdraw message" : `Dismiss ${message.name}'s message`
                        }
                        onClick={() => void run(message, "dismiss")}
                      />
                    }
                  >
                    <XIcon />
                  </TooltipTrigger>
                  <TooltipPopup>{asAuthor ? "Withdraw" : "Dismiss"}</TooltipPopup>
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
      if (message.kind === "people") continue;
      const text = assistantCitationsToPlainText(message.text);
      const toastId = toastManager.add({
        type: "info",
        title: `${message.name} sent a message for approval`,
        description: text.length > 120 ? `${text.slice(0, 120)}…` : text,
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

const NO_TYPISTS: ReadonlyArray<CollaboratorTypistFork> = [];

/** Who else cites what in a shared thread, so the transcript can mark it as theirs. */
export function useCollaboratorCitationsFork(threadRef: ScopedThreadRef | null) {
  const thread = useQuietThreadShell(threadRef);
  const configs = useServerConfigs();
  const served =
    threadRef !== null &&
    configs.get(threadRef.environmentId)?.environment.capabilities.collaboratorsFork === true &&
    thread?.collaboratorFork !== "frozen";
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
      message.threadId === threadRef?.threadId && message.kind !== "people"
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
