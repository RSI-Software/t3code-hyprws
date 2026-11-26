// Fork-only (colleague-collab): what the host did with a collaborator's message, shown to them.
// A sent one marks the message, queued or in the transcript; a dismissed one stays until cleared.
import { useAtomValue } from "@effect/atom-react";
import {
  type CollaboratorMessageFork,
  type EnvironmentId,
  isCollaboratorGrantFork,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { T, useGT } from "gt-react";
import { CheckIcon, CircleSlashIcon, XIcon } from "lucide-react";

import { environmentSession } from "~/state/session";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { TimelineRowTimestamp } from "../chat/TimelineRowParts";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A dismissed message in the waiting list, with the way to clear it. */
export function DismissedMessageFork({
  message,
  timestampFormat,
  busy,
  onClear,
}: {
  readonly message: CollaboratorMessageFork;
  readonly timestampFormat: TimestampFormat;
  readonly busy: boolean;
  readonly onClear: () => void;
}) {
  const gt = useGT();
  return (
    <li className="flex w-full flex-col items-end gap-1">
      <div className="flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed border-border px-3 py-2 text-muted-foreground/70 text-sm">
        <p className="whitespace-pre-wrap wrap-anywhere">
          {assistantCitationsToPlainText(message.text)}
        </p>
      </div>
      <div className="flex items-center gap-0.5 pe-1 text-muted-foreground text-xs">
        <span className="me-1 flex items-center px-1">
          <TimelineRowTimestamp
            createdAt={message.submittedAt}
            timestampFormat={timestampFormat}
            alwaysVisible
          />
        </span>
        <span className="flex items-center gap-1 px-1">
          <CircleSlashIcon aria-hidden className="size-3" />
          <T>Dismissed by the host</T>
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={busy}
                aria-label={gt("Clear dismissed message")}
                onClick={onClear}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Clear</T>
          </TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}

/** The waiting list's name: how many still wait, or that the host dismissed them all. */
export function useWaitingListLabelFork(messages: ReadonlyArray<CollaboratorMessageFork>) {
  const gt = useGT();
  const count = messages.filter((message) => message.outcome === undefined).length;
  return count === 0
    ? gt("Messages the host dismissed")
    : gt(
        "{count, plural, one {{count} message waiting for the host} other {{count} messages waiting for the host}}",
        { count },
      );
}

/** Beside a collaborator's message the host sent from the waiting list, on collaborators' screens. */
export function CollaboratorSentByHostFork({
  context,
  environmentId,
}: {
  readonly context: OrchestrationMessageContext | undefined;
  readonly environmentId: EnvironmentId;
}) {
  return context?.collaboratorFork?.sentByHost === true ? (
    <SentByHost environmentId={environmentId} />
  ) : null;
}

function SentByHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  // The host sent it, so only collaborators need telling.
  if (session._tag !== "Success" || !isCollaboratorGrantFork(session.value.permissions)) {
    return null;
  }
  return (
    <p className="me-1 flex items-center gap-1 text-muted-foreground text-xs">
      <CheckIcon aria-hidden className="size-3" />
      <T>Sent by the host</T>
    </p>
  );
}
