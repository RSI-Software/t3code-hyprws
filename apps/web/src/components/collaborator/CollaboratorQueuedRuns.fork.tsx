// Fork-only (colleague-collab): the queue stays the host's to run. On a collaborator's copy, queued
// messages read like sent ones: the words as written, with no Send now, edit, or remove.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";
import { T, useGT } from "gt-react";
import { Clock3Icon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { useQuietThreadShell } from "~/state/entities";

type PresentedMessage = Parameters<typeof resolveUserMessagePresentation>[0];

interface QueuedItem<Message, Thumbnail> {
  readonly key: string;
  readonly message: Message | undefined;
  readonly text: string;
  readonly thumbnails: ReadonlyArray<Thumbnail>;
  readonly pending: boolean;
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

/** On a collaborator's copy, draws the queue read-only; null for the host, who keeps the controls. */
export function useCollaboratorQueueFork(environmentId: EnvironmentId, threadId: ThreadId) {
  const asCollaborator =
    useQuietThreadShell(scopeThreadRef(environmentId, threadId))?.collaboratorFork !== undefined;
  return asCollaborator
    ? <Message extends PresentedMessage, Thumbnail, Props extends object>(
        items: ReadonlyArray<QueuedItem<Message, Thumbnail>>,
        row: QueuedRow<Message, Thumbnail, Props>,
        rowProps: Props,
      ) => <CollaboratorQueuedRuns items={items} row={row} rowProps={rowProps} />
    : null;
}

function CollaboratorQueuedRuns<Message extends PresentedMessage, Thumbnail, Props extends object>({
  items,
  row: Row,
  rowProps,
}: {
  readonly items: ReadonlyArray<QueuedItem<Message, Thumbnail>>;
  readonly row: QueuedRow<Message, Thumbnail, Props>;
  readonly rowProps: Props;
}) {
  const gt = useGT();
  return (
    <section
      aria-label={gt(
        "{count, plural, one {{count} queued message} other {{count} queued messages}}",
        { count: items.length },
      )}
      data-thread-queue="true"
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <ol className="flex flex-col items-end gap-3">
        {items.map((item, position) => {
          // The agent's text names the collaborator; people read the words as sent.
          const text = item.message ? resolveUserMessagePresentation(item.message).text : item.text;
          const previewText = isAttachmentOnlyBootstrapPrompt(text)
            ? ""
            : assistantCitationsToPlainText(
                composerFileLinksToPlainText(
                  replaceComposerContextReferences(text, (reference) => reference.label),
                ),
              ).trim();
          return (
            <li
              key={item.key}
              aria-label={gt("Queued message {position} of {total}, not sent", {
                position: position + 1,
                total: items.length,
              })}
              className="group/queued flex w-full flex-col items-end gap-1"
            >
              <Row
                {...rowProps}
                message={item.message}
                previewText={previewText}
                thumbnails={item.thumbnails}
                isEditing={false}
              >
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    <T>Saving</T>
                  </span>
                ) : null}
              </Row>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
