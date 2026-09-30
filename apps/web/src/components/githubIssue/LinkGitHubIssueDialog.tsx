import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { pullRequestHostOf, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects, useServerConfigs, useThreadShell } from "../../state/entities";
import { githubIssueEnvironment } from "../../state/githubIssues";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { resolveGitHubIssueReference } from "./githubIssueThreadLinks.logic";

/**
 * Which thread has the issue link dialog open, set by the command palette or the thread's issue
 * list and rendered once by the chat view, so the dialog outlives a palette that closes the
 * moment its command runs.
 */
const linkGitHubIssueDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("github-issues:link-dialog-thread"),
);

export function openLinkGitHubIssueDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkGitHubIssueDialogThreadAtom, threadRef);
}

/** Mounted once per chat view; shows the dialog for whichever thread asked for it. */
export function LinkGitHubIssueDialogHost() {
  const threadRef = useAtomValue(linkGitHubIssueDialogThreadAtom);
  const configs = useServerConfigs();
  if (
    threadRef === null ||
    configs.get(threadRef.environmentId)?.environment.capabilities.threadIssues !== true
  ) {
    return null;
  }
  return (
    <LinkGitHubIssueDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkGitHubIssueDialogThreadAtom, null)}
    />
  );
}

function LinkGitHubIssueDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const link = useAtomCommand(githubIssueEnvironment.linkToThread, { reportFailure: false });
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // A half-typed URL is not yet wrong: input errors wait for the first attempt to link.
  const [attempted, setAttempted] = useState(false);
  const ownProject = useMemo(() => {
    const identity = projects.find(
      (project) =>
        project.environmentId === threadRef.environmentId && project.id === thread?.projectId,
    )?.repositoryIdentity;
    if (identity?.provider !== "github") return null;
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    return repository === null ? null : { host: pullRequestHostOf(identity, "github"), repository };
  }, [projects, thread?.projectId, threadRef.environmentId]);
  const resolved = resolveGitHubIssueReference(reference, ownProject);

  const submit = async () => {
    setAttempted(true);
    if (resolved === null || "error" in resolved || pending) return;
    setPending(true);
    setSubmitError(null);
    const { target } = resolved;
    const result = await link({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        host: target.host,
        repository: target.repository,
        number: target.number,
        url: target.url,
        source: "manual",
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setSubmitError(failure instanceof Error ? failure.message : "Could not link the issue.");
  };

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link GitHub issue</DialogTitle>
          <DialogDescription>
            Attach an issue to this thread. A bare number means this thread's repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            placeholder="Issue URL or #42"
            value={reference}
            onChange={(event) => {
              setSubmitError(null);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {resolved !== null && "target" in resolved ? (
            <p className="truncate text-muted-foreground text-xs">
              {resolved.target.host}/{resolved.target.repository} #{resolved.target.number}
            </p>
          ) : null}
          {attempted && resolved !== null && "error" in resolved ? (
            <p className="text-destructive text-xs">{resolved.error}</p>
          ) : submitError ? (
            <p className="text-destructive text-xs">{submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || resolved === null}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
