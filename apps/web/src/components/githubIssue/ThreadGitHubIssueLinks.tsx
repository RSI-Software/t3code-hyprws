import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadIssueLink } from "@t3tools/contracts";
import { CircleHelpIcon, PlusIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
} from "../pullRequest/PullRequestListRow";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { GitHubIssueStateGlyph } from "./githubIssuePresentation";
import { openLinkGitHubIssueDialog } from "./LinkGitHubIssueDialog";

/**
 * The issues a thread links, above the issue list of that thread's panel: each opens its detail
 * beside the thread and can be unlinked. Nothing shows where the thread's environment keeps no
 * links or the thread has not been sent yet.
 */
export function ThreadGitHubIssueLinks({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const supported =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities.threadIssues === true;
  const thread = useThreadShell(supported ? threadRef : null);
  const unlink = useAtomCommand(githubIssueEnvironment.unlinkFromThread, { reportFailure: false });
  const [pending, setPending] = useState(false);
  if (thread === null) return null;
  const links = thread.issues ?? [];

  const unlinkIssue = async (link: ThreadIssueLink) => {
    setPending(true);
    const result = await unlink({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      },
    });
    setPending(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not unlink issue #${link.number}`,
      description: failure instanceof Error ? failure.message : undefined,
    });
  };

  return (
    <section aria-label="Issues linked to this thread">
      <div className="flex items-center gap-2 px-3 pb-1 font-medium text-muted-foreground/70 text-xs">
        <h2 className="shrink-0">Linked to this thread</h2>
        <span className="shrink-0 tabular-nums text-muted-foreground/50">{links.length}</span>
        <Separator className="min-w-2 flex-1" />
        <Button
          size="xs"
          variant="ghost"
          aria-label="Link an issue to this thread"
          onClick={() => openLinkGitHubIssueDialog(threadRef)}
        >
          <PlusIcon className="size-3" />
          Link
        </Button>
      </div>
      {links.length === 0 ? (
        <p className="px-3 pb-1 text-muted-foreground text-xs">
          No issues linked. Work on an issue, or link one by URL or number.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {links.map((link) => (
            <li
              key={`${link.host}/${link.repository}#${link.number}`}
              className="flex items-center"
            >
              <button
                type="button"
                className={`${PULL_REQUEST_ROW_CLASS} min-w-0 flex-1 px-2 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
                onClick={() =>
                  useRightPanelStore.getState().openGitHubIssue(threadRef, {
                    environmentId: threadRef.environmentId,
                    projectId: thread.projectId,
                    repository: link.repository,
                    number: link.number,
                  })
                }
              >
                <ThreadIssueLinkStateGlyph link={link} />
                <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{link.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {link.snapshot?.title ?? link.repository}
                </span>
              </button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0"
                aria-label={`Unlink issue #${link.number} from this thread`}
                disabled={pending}
                onClick={() => void unlinkIssue(link)}
              >
                <UnlinkIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A link not yet read from GitHub says so, rather than passing for an open issue. */
function ThreadIssueLinkStateGlyph({ link }: { readonly link: ThreadIssueLink }) {
  if (link.snapshot !== null) return <GitHubIssueStateGlyph state={link.snapshot.state} />;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <CircleHelpIcon
          role="img"
          aria-label="State not read yet"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </TooltipTrigger>
      <TooltipPopup>State not read yet</TooltipPopup>
    </Tooltip>
  );
}
