import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GitHubIssueDetail,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, CheckIcon, LinkIcon, MessageSquareIcon, UnlinkIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { PULL_REQUEST_ROW_CLASS } from "../pullRequest/PullRequestListRow";
import { Button } from "../ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { MenuItem } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { githubIssueLinkTarget, threadLinksGitHubIssue } from "./githubIssueThreadLinks.logic";

/**
 * One issue's thread links, as the detail panel shows them: whether its environment keeps links,
 * the threads that link it, and the link change itself. Links live on the issue's environment,
 * including when the panel sits beside a thread of another one.
 */
export function useGitHubIssueThreadLinks(
  environmentId: EnvironmentId | null,
  detail: Pick<GitHubIssueDetail, "url"> | null,
) {
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.threadIssues === true;
  const target = useMemo(() => (detail ? githubIssueLinkTarget(detail.url) : null), [detail]);
  const relationsAtom =
    supported && target !== null
      ? githubIssueEnvironment.linkedThreads({
          environmentId,
          input: { host: target.host, repository: target.repository, number: target.number },
        })
      : null;
  const relations = useEnvironmentQuery(relationsAtom);
  const link = useAtomCommand(githubIssueEnvironment.linkToThread, { reportFailure: false });
  const unlink = useAtomCommand(githubIssueEnvironment.unlinkFromThread, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const changeLink = async (threadId: ThreadId, linked: boolean): Promise<boolean> => {
    if (!supported || target === null || pending) return false;
    setPending(true);
    const key = {
      threadId,
      host: target.host,
      repository: target.repository,
      number: target.number,
    };
    const result = await (linked
      ? link({ environmentId, input: { ...key, url: target.url, source: "manual" } })
      : unlink({ environmentId, input: key }));
    setPending(false);
    if (relationsAtom !== null) appAtomRegistry.refresh(relationsAtom);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: linked ? "Could not link the issue" : "Could not unlink the issue",
        description: failure instanceof Error ? failure.message : undefined,
      });
    }
    return false;
  };

  return {
    supported: supported && target !== null,
    target,
    threads: relations.data?.threads ?? null,
    error: relations.error,
    pending,
    changeLink,
  };
}

type GitHubIssueThreadLinks = ReturnType<typeof useGitHubIssueThreadLinks>;

/** The actions menu's link entry: the thread beside the panel, or a picker when there is none. */
export function GitHubIssueThreadLinkMenuItem({
  links,
  composerTarget,
  environmentId,
  onPickThread,
}: {
  readonly links: GitHubIssueThreadLinks;
  readonly composerTarget: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId;
  readonly onPickThread: () => void;
}) {
  // A draft has no server thread to link yet, and a thread elsewhere keeps its own links.
  const thread = useThreadShell(
    composerTarget?.environmentId === environmentId ? composerTarget : null,
  );
  if (!links.supported || links.target === null) return null;
  const linkedHere = threadLinksGitHubIssue(thread?.issues, links.target);
  return (
    <MenuItem
      disabled={links.pending}
      onClick={() => {
        if (thread === null) onPickThread();
        else void links.changeLink(thread.id, !linkedHere);
      }}
    >
      {linkedHere ? <UnlinkIcon className="size-3.5" /> : <LinkIcon className="size-3.5" />}
      {linkedHere
        ? "Unlink from this thread"
        : thread !== null
          ? "Link to this thread"
          : "Link to a thread..."}
    </MenuItem>
  );
}

/** The detail panel's linked threads: each opens its thread, and each can be unlinked. */
export function GitHubIssueLinkedThreadList({
  links,
  environmentId,
}: {
  readonly links: GitHubIssueThreadLinks;
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  if (links.threads === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {links.error
          ? `Could not read linked threads: ${links.error}`
          : "Reading linked threads..."}
      </p>
    );
  }
  if (links.threads.length === 0) {
    return <p className="text-muted-foreground text-xs">No thread links this issue yet.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {links.threads.map((thread) => (
        <li key={thread.id} className="group/linked-thread flex items-center">
          <button
            type="button"
            className={`${PULL_REQUEST_ROW_CLASS} min-w-0 flex-1 px-2 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset`}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, thread.id)),
              })
            }
          >
            {thread.archivedAt === null ? (
              <MessageSquareIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ArchiveIcon
                aria-label="Archived"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">
              {thread.title || "Untitled thread"}
            </span>
          </button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={`Unlink from ${thread.title || "this thread"}`}
            disabled={links.pending}
            onClick={() => void links.changeLink(thread.id, false)}
          >
            <UnlinkIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Picks an active thread of the issue's environment to link it to. */
export function GitHubIssueThreadPicker({
  links,
  environmentId,
  onOpenChange,
}: {
  readonly links: GitHubIssueThreadLinks;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const threads = useThreadShells();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const target = links.target;
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const search = query.trim().toLocaleLowerCase();
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        `${thread.title} ${projectNames.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(search),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">Link issue to a thread</DialogTitle>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose a thread">
          <CommandInput placeholder="Search threads or projects..." disabled={links.pending} />
          <CommandList className="max-h-80 overflow-y-auto">
            {candidates.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No active threads found.
              </div>
            ) : (
              candidates.map((thread) => {
                const linked = target !== null && threadLinksGitHubIssue(thread.issues, target);
                return (
                  <CommandItem
                    key={thread.id}
                    value={thread.id}
                    disabled={links.pending || linked}
                    onClick={() =>
                      void links.changeLink(thread.id, true).then((done) => {
                        if (done) onOpenChange(false);
                      })
                    }
                  >
                    <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{thread.title || "Untitled thread"}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {projectNames.get(thread.projectId)}
                      </span>
                    </span>
                    {linked ? (
                      <>
                        <CheckIcon aria-hidden className="size-3.5" />
                        <span className="text-xs text-muted-foreground">Linked</span>
                      </>
                    ) : null}
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}
