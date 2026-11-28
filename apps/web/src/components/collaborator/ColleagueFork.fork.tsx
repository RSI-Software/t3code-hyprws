// Fork-only (colleague-collab): "Fork to my machine" on a colleague's thread. It copies the thread
// into a project on this app's own server, from the host while it answers and else from this
// device's copy, and the new thread's first notice links back to the original. Images and files
// copy too while the host answers.
import { useAtomValue } from "@effect/atom-react";
import {
  colleagueForkMessagesFork,
  readColleagueThreadFork,
} from "@t3tools/client-runtime/state/colleague-thread-read";
import type { ColleagueThreadReadFork } from "@t3tools/client-runtime/state/colleague-thread-read";
import {
  createEnvironmentRpcCommand,
  createRuntimeCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { forkTitleFork, waitForChildShellFork } from "~/state/threadFork.fork";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import { copyColleagueAttachmentFork } from "./colleagueForkAttachments.fork";
import { colleagueForkDialogThreadAtom } from "./colleagueForkDialogState.fork";
import { matchingProjectFork } from "./colleagueFork.logic.fork";
import { useSharerNamesFork } from "./SharedThreadCard.fork";

interface ReadInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const readCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "colleague-fork:read",
  execute: (input: ReadInput, registry) =>
    readColleagueThreadFork(
      input.environmentId,
      registry.get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      input.threadId,
    ),
});

interface CopyInput {
  readonly read: ColleagueThreadReadFork;
  readonly from: EnvironmentId;
  readonly to: EnvironmentId;
  readonly people: { readonly host: string; readonly you: string | null };
}

const copyCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "colleague-fork:copy-attachments",
  execute: ({ read, from, to, people }: CopyInput, registry) =>
    colleagueForkMessagesFork(
      read.messages,
      read.source === "host"
        ? copyColleagueAttachmentFork(registry, from, to)
        : () => Effect.succeed(null),
      people,
    ),
});

const forkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleague-fork:thread",
  tag: WS_METHODS.colleagueForkThreadFork,
});

export function ColleagueForkDialogHostFork() {
  const threadRef = useAtomValue(colleagueForkDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ColleagueForkDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(colleagueForkDialogThreadAtom, null)}
    />
  );
}

type ForkState =
  | { readonly status: "reading" }
  | { readonly status: "ready"; readonly read: ColleagueThreadReadFork }
  | { readonly status: "forking"; readonly read: ColleagueThreadReadFork }
  | { readonly status: "failed"; readonly read: ColleagueThreadReadFork; readonly message: string };

function ColleagueForkDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const sharer = useSharerNamesFork().get(threadRef.environmentId);
  const machine = useEnvironment(threadRef.environmentId)?.label;
  const host = sharer ?? machine ?? gt("the host");
  const you = thread?.collaboratorSubjectFork ?? null;
  const primary = usePrimaryEnvironmentId();
  const projects = useProjects();
  const local = projects.filter(
    (project) => project.environmentId === primary && project.archivedAt == null,
  );
  const source = projects.find(
    (project) =>
      project.environmentId === threadRef.environmentId && project.id === thread?.projectId,
  );
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const projectId = picked ?? matchingProjectFork(source, local) ?? local[0]?.id ?? null;
  const project = local.find((candidate) => candidate.id === projectId);
  const read = useAtomCommand(readCommand, { reportFailure: false });
  const copy = useAtomCommand(copyCommand, { reportFailure: false });
  const fork = useAtomCommand(forkCommand, { reportFailure: false });
  const [state, setState] = useState<ForkState>({ status: "reading" });
  // One id per dialog, so a retry after a lost reply resumes that thread instead of adding one.
  const [threadId] = useState(newThreadId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host or this device's copy once, so the dialog says what the fork holds.
  useEffect(() => {
    let current = true;
    void read(threadRef).then((result) => {
      if (!current) return;
      setState({
        status: "ready",
        read:
          result._tag === "Success"
            ? result.value
            : { messages: [], partial: false, source: "none" },
      });
    });
    return () => {
      current = false;
    };
  }, [read, threadRef]);

  const submit = async () => {
    if (state.status !== "ready" && state.status !== "failed") return;
    if (thread === null || primary === null || project === undefined) return;
    setState({ status: "forking", read: state.read });
    const copied = await copy({
      read: state.read,
      from: threadRef.environmentId,
      to: primary,
      people: { host, you },
    });
    if (copied._tag === "Failure") return setState({ status: "ready", read: state.read });
    const result = await fork({
      environmentId: primary,
      input: {
        threadId,
        projectId: project.id,
        title: forkTitleFork(thread.title),
        modelSelection: project.defaultModelSelection ?? thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        origin: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
        hostName: host,
        originTitle: thread.title,
        messages: copied.value.messages,
        partial: state.read.partial,
        missingAttachments: copied.value.missingAttachments,
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return setState({ status: "ready", read: state.read });
      const cause = squashAtomCommandFailure(result);
      return setState({
        status: "failed",
        read: state.read,
        message:
          collaboratorErrorTextFork(cause) ?? gt("Could not fork the thread to this machine."),
      });
    }
    const childRef = { environmentId: primary, threadId };
    await waitForChildShellFork(childRef);
    onClose();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(childRef) });
  };

  const busy = state.status === "reading" || state.status === "forking";
  const summary =
    state.status === "reading"
      ? gt("Reading the thread…")
      : state.read.source === "none"
        ? gt(
            "This device has no copy of it and {host} is offline, so the new thread starts empty and links to the original.",
            { host },
          )
        : state.read.source === "copy"
          ? gt(
              "{count, plural, one {{host} is offline, so this copies the # message your device kept.} other {{host} is offline, so this copies the # messages your device kept.}}",
              { host, count: state.read.messages.length },
            )
          : gt(
              "{count, plural, one {This copies the # message from {host}.} other {This copies all # messages from {host}.}}",
              { host, count: state.read.messages.length },
            );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "forking") onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{gt("Fork to my machine")}</DialogTitle>
          <DialogDescription>
            {gt(
              "A new thread in your project continues {host}'s thread. Your agent starts fresh, with the messages as context.",
              { host },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {local.length === 0 ? (
              <p role="alert" className="text-sm">
                {gt("Add a project on this machine first.")}
              </p>
            ) : (
              <Select
                // A retry resumes the thread the first attempt may have made, in that project.
                disabled={state.status === "forking" || state.status === "failed"}
                value={projectId}
                onValueChange={(next) => {
                  if (next !== null) setPicked(next);
                }}
              >
                <SelectTrigger aria-label={gt("Project")}>
                  <SelectValue>
                    {(value: ProjectId | null) =>
                      local.find((candidate) => candidate.id === value)?.title ?? gt("Project")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {local.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            <p role="status" className="text-muted-foreground text-sm">
              {summary}
              {state.status !== "reading" && state.read.partial
                ? ` ${gt("Its oldest messages are not included.")}`
                : ""}
              {state.status !== "reading" &&
              state.read.source !== "host" &&
              state.read.messages.some(({ attachments }) => attachments.length > 0)
                ? ` ${gt("Images and files are not copied.")}`
                : ""}
            </p>
            {state.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={state.status === "forking"} onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button disabled={busy || project === undefined} onClick={() => void submit()}>
            {state.status === "forking"
              ? gt("Forking…")
              : gt("Fork", { $context: "verb, button that forks the thread" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** "Open original" on a forked thread's first notice, while this app still knows the host. */
export function ColleagueOriginLinkFork({
  payload,
}: {
  readonly payload: OrchestrationV2TurnItem | undefined;
}) {
  const gt = useGT();
  const origin = payload?.type === "system_notice" ? payload.colleagueOriginFork : undefined;
  const known = useEnvironment(origin?.environmentId ?? null) !== null;
  if (origin === undefined || !known) return null;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(origin)}
      className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
    >
      {gt("Open original")}
    </Link>
  );
}
