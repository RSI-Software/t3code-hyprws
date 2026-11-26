// Fork-only (colleague-collab): the queue stays the host's to run. On a collaborator's copy, queued
// messages read like sent ones, in the words as written; only their own carry edit and remove.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ChatAttachment, EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";
import { T, useGT } from "gt-react";
import { Clock3Icon, PencilIcon, XIcon } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCollaboratorCitationsFork } from "./CollaboratorChat.fork";

type PresentedMessage = Parameters<typeof resolveUserMessagePresentation>[0];

interface QueuedItem<Message, Thumbnail> {
  readonly key: string;
  readonly message: Message | undefined;
  readonly runId: RunId | null;
  readonly messageId: MessageId | null;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly thumbnails: ReadonlyArray<Thumbnail>;
  readonly pending: boolean;
}

interface QueueProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly editingRunId: RunId | null;
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: {
    readonly runId: RunId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) => void;
  readonly onCancelEdit: () => void;
}

type QueuedRow<Message, Thumbnail, Props> = ComponentType<
  Props & {
    readonly message: Message | undefined;
    readonly previewText: string;
    readonly thumbnails: ReadonlyArray<Thumbnail>;
    readonly isEditing: boolean;
    readonly children: ReactNode;
  }
>;

/** On a collaborator's copy, draws the queue for them; null for the host, who keeps the controls. */
export function useCollaboratorQueueFork(environmentId: EnvironmentId, threadId: ThreadId) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const access = useQuietThreadShell(threadRef)?.collaboratorFork;
  const asCollaborator = access !== undefined;
  // The server refuses queue changes without send access, own messages included.
  const { you } = useCollaboratorCitationsFork(asCollaborator ? threadRef : null);
  const owner = access === "send" ? you : null;
  return asCollaborator
    ? <Message extends PresentedMessage, Thumbnail, Props extends QueueProps>(
        items: ReadonlyArray<QueuedItem<Message, Thumbnail>>,
        row: QueuedRow<Message, Thumbnail, Props>,
        rowProps: Props,
      ) => <CollaboratorQueuedRuns items={items} row={row} rowProps={rowProps} editor={owner} />
    : null;
}

function CollaboratorQueuedRuns<
  Message extends PresentedMessage,
  Thumbnail,
  Props extends QueueProps,
>({
  items,
  row: Row,
  rowProps,
  editor,
}: {
  readonly items: ReadonlyArray<QueuedItem<Message, Thumbnail>>;
  readonly row: QueuedRow<Message, Thumbnail, Props>;
  readonly rowProps: Props;
  readonly editor: string | null;
}) {
  const gt = useGT();
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: rowProps.environmentId,
      input: { threadId: rowProps.threadId, runId },
    });
    setBusyRunId(null);
  };
  return (
    <section
      aria-label={gt(
        "{count, plural, one {{count} queued message} other {{count} queued messages}}",
        { count: items.length },
      )}
      data-thread-queue="true"
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {gt("{count, plural, one {{count} queued} other {{count} queued}}", {
          count: items.length,
        })}
      </span>
      <ol className="flex flex-col items-end gap-3">
        {items.map((item, position) => {
          const presentation = item.message ? resolveUserMessagePresentation(item.message) : null;
          const text = item.text;
          const previewText = isAttachmentOnlyBootstrapPrompt(text)
            ? ""
            : assistantCitationsToPlainText(
                composerFileLinksToPlainText(
                  replaceComposerContextReferences(text, (reference) => reference.label),
                ),
              ).trim();
          // The server attributes a collaborator's message and lets them change only their own.
          const ownRun =
            editor !== null &&
            presentation?.guestName === editor &&
            item.runId !== null &&
            item.messageId !== null
              ? {
                  runId: item.runId,
                  messageId: item.messageId,
                  text,
                  attachments: item.attachments,
                }
              : null;
          const isEditing = ownRun !== null && ownRun.runId === rowProps.editingRunId;
          return (
            <li
              key={item.key}
              aria-label={gt("Queued message {position} of {total}, not sent", {
                position: position + 1,
                total: items.length,
              })}
              aria-current={isEditing ? "true" : undefined}
              className="group/queued flex w-full flex-col items-end gap-1"
            >
              <Row
                {...rowProps}
                message={item.message}
                previewText={previewText}
                thumbnails={item.thumbnails}
                isEditing={isEditing}
              >
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    <T>Saving</T>
                  </span>
                ) : null}
                {ownRun === null ? null : isEditing ? (
                  <>
                    <span className="px-1 text-foreground">
                      <T>Editing in the composer</T>
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={gt("Cancel editing queued message")}
                      onClick={rowProps.onCancelEdit}
                    >
                      <T>Cancel</T>
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={gt("Edit queued message")}
                          disabled={busyRunId !== null || rowProps.editBlockedReason !== null}
                          onClick={() => rowProps.onEditQueuedRun(ownRun)}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {rowProps.editBlockedReason ?? gt("Edit in the composer")}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={gt("Remove queued message")}
                            disabled={busyRunId !== null}
                            onClick={() => void remove(ownRun.runId)}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup>
                        <T>Remove from queue</T>
                      </TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </Row>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
