// Spike RSI-714 (colleague-collab): "Ask the agent" makes the agent answer a shared-thread message
// it would otherwise judge to be between people: from the send menu, or on a quiet row.
// Raw strings: the spike skips i18n.
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type OrchestrationMessageContext,
  type ScopedThreadRef,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { ChevronUpIcon, MessageCircleQuestionIcon } from "lucide-react";
import { use, useState } from "react";

import { readThreadTurnItems, useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { newMessageId } from "~/lib/utils";
import { TimelineRowActivityCtx, TimelineRowCtx } from "../chat/timelineRowContext";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { submitMessageCommand } from "./CollaboratorChat.fork";
import { typingSubscription } from "./CollaboratorTyping.fork";

// Draft keys whose next send carries `forceReplyFork`; the send path takes it when it builds context.
const armed = new Set<string>();
export const armForceReplyFork = (key: string) => void armed.add(key);
export const disarmForceReplyFork = (key: string) => void armed.delete(key);
export const takeForceReplyFork = (key: string) => armed.delete(key);

export const withForceReplyFork = (
  context: OrchestrationMessageContext | undefined,
  forced: boolean,
): OrchestrationMessageContext | undefined =>
  forced ? { version: 1, records: [], ...context, forceReplyFork: true } : context;

/** Someone else can see this thread: the host shared it, or this session is a collaborator. */
export function useThreadSharedFork(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null | undefined,
) {
  const configs = useServerConfigs();
  const served =
    thread != null &&
    configs.get(thread.environmentId)?.environment.capabilities.collaboratorsFork === true;
  const { data } = useEnvironmentQuery(
    served && thread != null
      ? typingSubscription({ environmentId: thread.environmentId, input: { threadId: thread.id } })
      : null,
  );
  return data?.shared === true;
}

/** The chevron beside Send in a shared thread; its one item sends the draft as a forced ask. */
export function AskAgentSendMenuFork({
  disabled,
  onAsk,
}: {
  readonly disabled: boolean;
  readonly onAsk: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={disabled}
            aria-label="More send options"
          />
        }
      >
        <ChevronUpIcon />
      </MenuTrigger>
      <MenuPopup side="top" align="end">
        <MenuItem onClick={onAsk}>
          <MessageCircleQuestionIcon />
          Ask the agent
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** The skipped line: the user message before the quiet reply, in its author's own words. */
const skippedLine = (threadRef: ScopedThreadRef, quietItemId: TurnItemId | undefined) => {
  const items = readThreadTurnItems(threadRef);
  const at = items.findIndex(({ item }) => item.id === quietItemId);
  for (let index = (at === -1 ? items.length : at) - 1; index >= 0; index--) {
    const { item } = items[index]!;
    if (item.type !== "user_message") continue;
    const attribution = item.context?.collaboratorFork;
    return attribution ?? { name: null, text: item.text };
  }
  return null;
};

const askText = (line: { readonly name: string | null; readonly text: string } | null) => {
  const text = line?.text.trim();
  if (!text) return "Answer the message above.";
  const quoted = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return line?.name
    ? `Answer ${line.name}'s message: "${quoted}"`
    : `Answer the message above: "${quoted}"`;
};

/** On a quiet row: ask the agent to answer the line it skipped. */
export function QuietRowAskAgentFork({
  quietItemId,
}: {
  readonly quietItemId: TurnItemId | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const shell = useQuietThreadShell(ctx.threadRef);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const submitForApproval = useAtomCommand(submitMessageCommand);
  const [busy, setBusy] = useState(false);
  const threadRef = ctx.threadRef;
  if (threadRef === null || shell === null || !ctx.canOperateThread || activity.isWorking) {
    return null;
  }
  if (shell.collaboratorFork === "frozen") return null;

  const ask = async () => {
    setBusy(true);
    const text = askText(skippedLine(threadRef, quietItemId));
    // An approve collaborator's ask waits for the host like any of their messages.
    const result =
      shell.collaboratorFork === "approve"
        ? await submitForApproval({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, text },
          })
        : await startTurn({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              message: {
                messageId: newMessageId(),
                role: "user",
                text,
                attachments: [],
                context: { version: 1, records: [], forceReplyFork: true },
              },
              runtimeMode: shell.runtimeMode,
              interactionMode: shell.interactionMode,
              dispatchMode: "queue",
            },
          });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not ask the agent",
        description: formatEnvironmentQueryError(result.cause),
      });
    }
  };

  return (
    <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => void ask()}>
      <MessageCircleQuestionIcon />
      Ask the agent
    </Button>
  );
}
