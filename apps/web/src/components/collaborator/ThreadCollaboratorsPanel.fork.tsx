// Fork-only (colleague-collab): the thread details card lists who the thread is shared with, and
// switches each between Needs approval and Can send. Hidden while nobody has access.
import { useAtomValue } from "@effect/atom-react";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type { CollaboratorAccessFork, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { UserIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuerySelector } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ACCESS, setAccessCommand, threadSharesQuery } from "./collaboratorAccess.fork";
import { openCollaboratorShareDialog } from "./collaboratorShareDialogState.fork";

interface ThreadCollaboratorsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function ThreadCollaboratorsPanelFork({
  show,
  ...props
}: ThreadCollaboratorsPanelProps & { readonly show: boolean }) {
  // Only a host can share; a collaborator's own copy shows nothing here.
  const canShare = useAtomValue(setAccessCommand.permissionAtom(props.environmentId));
  return show && canShare ? (
    <ThreadCollaboratorsList key={`${props.environmentId}:${props.threadId}`} {...props} />
  ) : null;
}

function ThreadCollaboratorsList({ environmentId, threadId }: ThreadCollaboratorsPanelProps) {
  const sharesAtom = threadSharesQuery({ environmentId, input: { threadId } });
  const shares = useEnvironmentQuerySelector(sharesAtom, selectEnvironmentQueryData);
  const setAccess = useAtomCommand(setAccessCommand);
  const [busySubject, setBusySubject] = useState<string | null>(null);

  const sharedWith = shares?.sharedWith ?? [];
  if (sharedWith.length === 0) return null;

  const changeAccess = async (subject: string, access: CollaboratorAccessFork) => {
    setBusySubject(subject);
    await setAccess({ environmentId, input: { threadId, subject, access } });
    setBusySubject(null);
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-collaborators-heading"
      title="Collaborators"
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Share with collaborator"
                onClick={() => openCollaboratorShareDialog({ environmentId, threadId })}
              >
                <UserPlusIcon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Share with collaborator</TooltipPopup>
        </Tooltip>
      }
    >
      <ul className="m-0 list-none p-0">
        {sharedWith.map((collaborator) => (
          <li
            key={collaborator.subject}
            className={cn(
              "flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <UserIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {collaborator.name}
              </span>
              <p className="truncate text-2xs text-muted-foreground">
                {ACCESS[collaborator.access].label}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Switch
                    checked={collaborator.access === "send"}
                    disabled={busySubject !== null}
                    aria-label={`Let ${collaborator.name} send without approval`}
                    onCheckedChange={(send) =>
                      void changeAccess(collaborator.subject, send ? "send" : "approve")
                    }
                  />
                }
              />
              <TooltipPopup side="left">
                {collaborator.access === "send"
                  ? "Turn off to approve each message first"
                  : "Turn on to let messages reach the agent at once"}
              </TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
