// Fork-only (colleague-collab): messages for an offline colleague's thread wait on this app's own
// server and go out through the normal path once their environment reconnects: a send where the
// share allows it, else a request for their approval. Each keeps its id, so a repeat lands once.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  collaboratorMessageCommandId,
  CommandId,
  type ColleagueQueuedMessageFork,
  type EnvironmentId,
  MessageId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { useGT } from "gt-react";
import { Atom } from "effect/reactivity";
import { CircleAlertIcon, Clock3Icon, PencilIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useQuietThreadShells, useServerConfigs } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { TimelineRowTimestamp } from "../chat/TimelineRowParts";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";
import {
  colleagueOutboxReadyFork,
  flushColleagueOutboxFork,
  type OutboxRouteFork,
} from "./colleagueOutbox.logic.fork";

/** @public A message left for the host of a shared thread to send. */
export const submitMessageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "send message for approval",
  tag: WS_METHODS.collaboratorSubmitMessageFork,
});
const queueCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:queue-message",
  tag: WS_METHODS.colleagueQueueMessageFork,
});
const unqueueCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:unqueue-message",
  tag: WS_METHODS.colleagueUnqueueMessageFork,
});
const outboxFamily = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "colleagues:outbox",
  tag: WS_METHODS.colleagueSubscribeOutboxFork,
});

const NO_QUEUED: ReadonlyArray<ColleagueQueuedMessageFork> = [];
const FIRST_RETRY_MS = 30_000;
const LAST_RETRY_MS = 10 * 60_000;
const quiet = { reportFailure: false } as const;

// Messages that failed to send or leave the queue: each waits twice as long as before it tries
// again while their colleague stays connected, and a reconnect tries it at once. Their rows say
// they could not send meanwhile.
const heldAtom = Atom.make<
  ReadonlyMap<string, { readonly tries: number; readonly retryAt: number }>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("colleagues:outbox-held"));

/** Holds a message after a failure; true the first time, when the sender should hear of it. */
function hold(id: string) {
  const held = appAtomRegistry.get(heldAtom);
  const tries = (held.get(id)?.tries ?? 0) + 1;
  const wait = Math.min(FIRST_RETRY_MS * 2 ** (tries - 1), LAST_RETRY_MS);
  appAtomRegistry.set(heldAtom, new Map(held).set(id, { tries, retryAt: Date.now() + wait }));
  return tries === 1;
}

function release(ids: ReadonlyArray<string>) {
  const held = new Map(appAtomRegistry.get(heldAtom));
  if (ids.filter((id) => held.delete(id)).length > 0) appAtomRegistry.set(heldAtom, held);
}

/** This app's own server, when it keeps saved colleagues and so their queue. */
function useOutboxServer() {
  const primary = usePrimaryEnvironmentId();
  return colleaguesServedFork(useServerConfigs(), primary) ? primary : null;
}

function useOutbox(server: EnvironmentId | null) {
  const { data } = useEnvironmentQuery(
    server === null ? null : outboxFamily({ environmentId: server, input: {} }),
  );
  return data ?? NO_QUEUED;
}

/**
 * A colleague's thread: what waits for it here, whether a send now queues (their environment is
 * not connected), and the queue's changes.
 */
export function useColleagueOutboxFork(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
) {
  const server = useOutboxServer();
  const { data: colleagues } = useEnvironmentQuery(server === null ? null : colleaguesAtom(server));
  const { environments } = useEnvironments();
  const queue = useAtomCommand(queueCommand, quiet);
  const unqueue = useAtomCommand(unqueueCommand);
  const queued = useOutbox(server).filter(
    (message) => message.environmentId === thread?.environmentId && message.threadId === thread.id,
  );
  const colleague = colleagues?.find(
    (candidate) => candidate.environmentId === thread?.environmentId,
  );
  const environment = environments.find(
    (candidate) => candidate.environmentId === thread?.environmentId,
  );
  const online = environment?.connection.phase === "connected";
  return {
    queued,
    online,
    held: useAtomValue(heldAtom),
    name: colleague?.name ?? environment?.label ?? "",
    /** Only a saved colleague's thread queues, and only while their machine is away. */
    queues: server !== null && thread != null && colleague !== undefined && !online,
    queue: (text: string) =>
      server === null || thread == null
        ? null
        : queue({
            environmentId: server,
            input: { environmentId: thread.environmentId, threadId: thread.id, text },
          }),
    /** Resolves true once the message left the queue. */
    unqueue: async (id: string) =>
      server !== null &&
      (await unqueue({ environmentId: server, input: { id } }))._tag === "Success",
  };
}

/** Queued messages wear the waiting-message look, with Edit and Withdraw while they wait. */
export function QueuedForColleagueFork({
  environmentId,
  messages,
  name,
  online,
  held,
  onEdit,
  onWithdraw,
}: {
  readonly environmentId: EnvironmentId;
  readonly messages: ReadonlyArray<ColleagueQueuedMessageFork>;
  readonly name: string;
  readonly online: boolean;
  /** Messages that failed to send and wait to try again. */
  readonly held: ReadonlyMap<string, unknown>;
  readonly onEdit: (message: ColleagueQueuedMessageFork) => void;
  readonly onWithdraw: (message: ColleagueQueuedMessageFork) => void;
}) {
  const gt = useGT();
  const timestampFormat = useEnvironmentSettings(environmentId).timestampFormat;
  return (
    <section
      aria-label={gt("Sends when {name} is back", { name })}
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col pb-4"
    >
      <ol className="flex flex-col items-end gap-3" aria-live="polite">
        {messages.map((message) => (
          <li key={message.id} className="group/queued flex w-full flex-col items-end gap-1">
            <div className="flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed border-border px-3 py-2 text-muted-foreground text-sm">
              <p className="whitespace-pre-wrap wrap-anywhere">
                {assistantCitationsToPlainText(message.text)}
              </p>
            </div>
            <div className="flex items-center gap-0.5 pe-1 text-muted-foreground text-xs">
              <span className="me-1 flex items-center px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
                <TimelineRowTimestamp
                  createdAt={message.queuedAt}
                  timestampFormat={timestampFormat}
                  alwaysVisible
                />
              </span>
              {online && held.has(message.id) ? (
                <span className="flex items-center gap-1 px-1 text-warning">
                  <CircleAlertIcon aria-hidden className="size-3" />
                  {gt("Could not send, retrying")}
                </span>
              ) : (
                <span className="flex items-center gap-1 px-1">
                  <Clock3Icon aria-hidden className="size-3" />
                  {online ? gt("Sending…") : gt("Sends when {name} is back", { name })}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Edit queued message")}
                      onClick={() => onEdit(message)}
                    />
                  }
                >
                  <PencilIcon />
                </TooltipTrigger>
                <TooltipPopup>{gt("Edit")}</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Withdraw message")}
                      onClick={() => onWithdraw(message)}
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipPopup>{gt("Withdraw")}</TooltipPopup>
              </Tooltip>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Delivers queued messages as each colleague's environment connects; mounted once per app. */
export function ColleagueOutboxFlushFork() {
  const server = useOutboxServer();
  return server === null ? null : <OutboxFlush server={server} />;
}

function OutboxFlush({ server }: { readonly server: EnvironmentId }) {
  const gt = useGT();
  const queued = useOutbox(server);
  const { environments } = useEnvironments();
  const shells = useQuietThreadShells();
  const submit = useAtomCommand(submitMessageCommand, quiet);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, quiet);
  const unqueue = useAtomCommand(unqueueCommand, quiet);
  const flushing = useRef(false);
  // The queue as it is now, so a message withdrawn or edited mid-flush is skipped.
  const live = useRef(queued);
  // Bumped after each flush, so messages that became ready during it get their turn.
  const [, setRound] = useState(0);
  // After a reload the session's scopes arrive after the socket connects, and a send before them
  // is refused, so a colleague counts as back once both have.
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const connected = new Set(
    environments
      .filter(
        (environment) =>
          environment.connection.phase === "connected" && operable.has(environment.environmentId),
      )
      .map((environment) => environment.environmentId),
  );
  const shellOf = (message: ColleagueQueuedMessageFork) =>
    shells.find(
      (shell) => shell.environmentId === message.environmentId && shell.id === message.threadId,
    );
  const route = (message: ColleagueQueuedMessageFork): OutboxRouteFork => {
    if (!connected.has(message.environmentId)) return null;
    if ((appAtomRegistry.get(heldAtom).get(message.id)?.retryAt ?? 0) > Date.now()) return null;
    if (!live.current.some((candidate) => candidate.id === message.id)) return null;
    const access = shellOf(message)?.collaboratorFork;
    return access === "send" || access === "approve" ? access : null;
  };
  const deliver = async (message: ColleagueQueuedMessageFork, how: "send" | "approve") => {
    const shell = shellOf(message);
    if (shell === undefined) return false;
    const target = collaboratorMessageCommandId(message.id);
    const result =
      how === "approve"
        ? await submit({
            environmentId: message.environmentId,
            input: { threadId: message.threadId, text: message.text, id: message.id },
          })
        : await startTurn({
            environmentId: message.environmentId,
            input: {
              threadId: message.threadId,
              commandId: CommandId.make(target),
              message: {
                messageId: MessageId.make(target),
                role: "user",
                text: message.text,
                attachments: [],
              },
              runtimeMode: shell.runtimeMode,
              interactionMode: shell.interactionMode,
              dispatchMode: "queue",
              resendAfterSocketLoss: false,
            },
          });
    if (result._tag === "Success") return true;
    if (hold(message.id) && !isAtomCommandInterrupted(result)) {
      const environment = environments.find(
        (candidate) => candidate.environmentId === message.environmentId,
      );
      toastManager.add({
        type: "error",
        title: gt("Could not send your queued message to {name}", {
          name: environment?.label ?? message.environmentId,
        }),
        description:
          collaboratorErrorTextFork(squashAtomCommandFailure(result)) ??
          gt("Could not deliver the message."),
      });
    }
    return false;
  };
  // A failed removal holds the message too; its retry lands once, as the host skips a repeat.
  const remove = async (message: ColleagueQueuedMessageFork) => {
    if ((await unqueue({ environmentId: server, input: { id: message.id } }))._tag === "Success") {
      release([message.id]);
      return true;
    }
    hold(message.id);
    return false;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers to a colleague's server, an external system, once its environment connects.
  useEffect(() => {
    live.current = queued;
    const held = appAtomRegistry.get(heldAtom);
    release(
      [...held.keys()].filter((id) => {
        const message = queued.find((candidate) => candidate.id === id);
        return message === undefined || !connected.has(message.environmentId);
      }),
    );
    if (flushing.current) return;
    if (!colleagueOutboxReadyFork(queued, route)) {
      // A retry already due waits on what else holds it, such as the share, which re-renders.
      const now = Date.now();
      const due = [...appAtomRegistry.get(heldAtom).values()].map(({ retryAt }) => retryAt);
      const next = Math.min(...due.filter((retryAt) => retryAt > now));
      if (!Number.isFinite(next)) return;
      const retry = setTimeout(() => setRound((value) => value + 1), next - now);
      return () => clearTimeout(retry);
    }
    flushing.current = true;
    void flushColleagueOutboxFork(queued, { route, deliver, remove }).finally(() => {
      flushing.current = false;
      setRound((value) => value + 1);
    });
  });
  return null;
}
