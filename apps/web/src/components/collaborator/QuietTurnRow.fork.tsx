// Fork-only (colleague-collab): the agent's slot when the server marked its reply quiet, because a
// shared-thread message was between people. Never shows the reply's marker text.
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { EarIcon, MessageCircleQuestionIcon } from "lucide-react";
import { use, useState } from "react";

import { newMessageId } from "~/lib/utils";
import { readThreadTurnItems, useQuietThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
} from "../chat/timelineRowContext";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import { forceReplyMessageFork } from "./sendMenu.fork";

type MessageRow = Extract<TimelineRow, { kind: "message" }>;

export const isQuietTurnFork = (row: MessageRow) =>
  row.projectedItem?.item.type === "assistant_message" && row.projectedItem.item.quietFork === true;

const QUOTE_LIMIT = 400;

/**
 * The forced ask for the line a quiet reply skipped: the last message of its run, in its author's
 * own words, since the message text holds the attributed form the agent read.
 */
export const askSkippedLineFork = (
  items: ReadonlyArray<{ readonly item: ThreadStructureTurnItem }>,
  quiet: Pick<OrchestrationV2TurnItem, "runId" | "ordinal">,
) => {
  const line = items.findLast(
    ({ item }) =>
      item.type === "user_message" && item.runId === quiet.runId && item.ordinal < quiet.ordinal,
  )?.item;
  const said = line?.type === "user_message" ? line.context?.collaboratorFork : undefined;
  const text = said?.text.trim();
  if (!said?.name || !text) return "Answer the message above.";
  const quoted = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
  return `Answer ${said.name}'s message: "${quoted}"`;
};

export function QuietTurnRowFork({ row }: { readonly row: MessageRow }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-0.5 text-muted-foreground text-xs">
      <span className="flex items-center gap-1.5">
        <EarIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="italic">
          <T>Agent stayed quiet</T>
        </span>
      </span>
      {row.projectedItem ? <AskAgentFork quiet={row.projectedItem.item} /> : null}
    </div>
  );
}

/** Offered on the thread's latest turn only, so it is gone once the agent answers. */
function AskAgentFork({ quiet }: { readonly quiet: OrchestrationV2TurnItem }) {
  const gt = useGT();
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const shell = useQuietThreadShell(ctx.threadRef);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [asking, setAsking] = useState(false);
  const threadRef = ctx.threadRef;
  if (
    threadRef === null ||
    shell === null ||
    !ctx.canOperateThread ||
    activity.isWorking ||
    quiet.runId === null ||
    quiet.runId !== activity.latestRunId ||
    // Approval sends text only, so the forced ask stays with those who send directly.
    shell.collaboratorFork === "approve" ||
    shell.collaboratorFork === "frozen"
  ) {
    return null;
  }

  const ask = async () => {
    setAsking(true);
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: askSkippedLineFork(readThreadTurnItems(threadRef), quiet),
          attachments: [],
          ...forceReplyMessageFork(true, () => undefined),
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
      },
    });
    setAsking(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not ask the agent"),
        description:
          collaboratorErrorTextFork(squashAtomCommandFailure(result)) ??
          gt("Could not deliver the message."),
      });
    }
  };

  return (
    <Button size="xs" variant="ghost-muted" disabled={asking} onClick={() => void ask()}>
      <MessageCircleQuestionIcon />
      {gt("Ask the agent")}
    </Button>
  );
}
