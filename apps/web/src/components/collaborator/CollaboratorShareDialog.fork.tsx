// Fork-only (colleague-collab): share this thread with a collaborator, set whether their messages
// need approval, and stop sharing, all in one list of people with access. A first share mints a pairing link; a collaborator already
// paired sees the thread live.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  selectEnvironmentQueryData,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CollaboratorAccessFork,
  CollaboratorNameFork,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CheckIcon, CopyIcon, PlusIcon, UserIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQueryRefresh, useEnvironmentQuerySelector } from "~/state/query";
import { readPreparedConnection } from "~/state/session";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ACCESS, setAccessCommand, threadSharesQuery } from "./collaboratorAccess.fork";
import { collaboratorShareDialogThreadAtom } from "./collaboratorShareDialogState.fork";

const isCollaboratorName = Schema.is(CollaboratorNameFork);

const shareThreadWithCollaboratorCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "share thread with collaborator",
  tag: WS_METHODS.collaboratorShareThreadFork,
});

const unshareThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "stop sharing thread with collaborator",
  tag: WS_METHODS.collaboratorUnshareThreadFork,
});

function AccessSelect({
  value,
  label,
  disabled,
  onChange,
}: {
  readonly value: CollaboratorAccessFork;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (access: CollaboratorAccessFork) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "send" || next === "approve") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto shrink-0">
        <SelectValue>{(selected: CollaboratorAccessFork) => ACCESS[selected].label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
        {(["approve", "send"] as const).map((access) => (
          <SelectItem key={access} value={access}>
            <span className="flex flex-col py-0.5">
              <span>{ACCESS[access].label}</span>
              <span className="text-muted-foreground text-xs">{ACCESS[access].detail}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

// The server prefers its tunnel's public hostname, then a public origin the host reached it on.
const linkBase = (threadRef: ScopedThreadRef) => {
  const linkBaseUrl = readPreparedConnection(threadRef.environmentId)?.httpBaseUrl;
  return linkBaseUrl === undefined ? {} : { linkBaseUrl };
};

export function CollaboratorShareDialogHostFork() {
  const threadRef = useAtomValue(collaboratorShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <CollaboratorShareDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(collaboratorShareDialogThreadAtom, null)}
    />
  );
}

type ShareState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | {
      readonly status: "created";
      readonly name: string;
      readonly pairingUrl: string;
      readonly localOnly: boolean;
      readonly knownCollaborator: boolean;
    }
  | { readonly status: "failed"; readonly message: string };

function CollaboratorShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const canShare = useAtomValue(
    shareThreadWithCollaboratorCommand.permissionAtom(threadRef.environmentId),
  );
  const share = useAtomCommand(shareThreadWithCollaboratorCommand, { reportFailure: false });
  const unshare = useAtomCommand(unshareThreadCommand);
  const setAccess = useAtomCommand(setAccessCommand);
  const sharesAtom = threadSharesQuery({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const shares = useEnvironmentQuerySelector(sharesAtom, selectEnvironmentQueryData);
  const { refresh: refreshShares } = useEnvironmentQueryRefresh(sharesAtom);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "collaborator link" });
  const [name, setName] = useState("");
  const [state, setState] = useState<ShareState>({ status: "idle" });
  const trimmedName = name.trim();
  const validName = isCollaboratorName(trimmedName);

  const sharedWith = shares?.sharedWith ?? [];
  const suggestions = (shares?.collaborators ?? []).filter(
    (collaborator) => !sharedWith.some((shared) => shared.subject === collaborator.subject),
  );

  const create = async (collaboratorName: string) => {
    setState({ status: "creating" });
    const result = await share({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        collaboratorName,
        ...linkBase(threadRef),
      },
    });
    refreshShares();
    if (result._tag === "Success") {
      setName("");
      setState({ status: "created", name: collaboratorName, ...result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Could not create a collaborator link.",
    });
  };

  const stopSharing = async (subject: string) => {
    await unshare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, subject },
    });
    setState({ status: "idle" });
    refreshShares();
  };

  const changeAccess = async (subject: string, next: CollaboratorAccessFork) => {
    await setAccess({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, subject, access: next },
    });
  };

  const busy = state.status === "creating";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share with collaborator</DialogTitle>
          <DialogDescription>
            Collaborators follow this thread live and message the agent under their name.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (validName && !busy) void create(trimmedName);
              }}
            >
              <Input
                autoFocus
                aria-label="Collaborator name"
                placeholder="Name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <Button type="submit" size="sm" disabled={!canShare || !validName || busy}>
                {busy ? "Sharing..." : "Share"}
              </Button>
            </form>
            {suggestions.length > 0 ? (
              <div className="-mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                <span>Shared before:</span>
                {suggestions.map((collaborator) => (
                  <Button
                    key={collaborator.subject}
                    size="xs"
                    variant="outline"
                    disabled={!canShare || busy}
                    onClick={() => void create(collaborator.name)}
                  >
                    <PlusIcon />
                    {collaborator.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {state.status === "created" ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm">
                  {state.knownCollaborator
                    ? `${state.name} already sees it in their sidebar. For another device, send this link.`
                    : `Send ${state.name} this link to open the thread in T3 Code.`}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    aria-label="Collaborator link"
                    value={state.pairingUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(state.pairingUrl)}
                  >
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                {state.localOnly ? (
                  <p role="status" className="text-warning text-xs">
                    No public address found, so this link works only on your network.
                  </p>
                ) : null}
              </div>
            ) : null}
            {state.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
            {sharedWith.length > 0 ? (
              <section
                aria-labelledby="collaborator-access-heading"
                className="flex flex-col gap-1"
              >
                <h3
                  id="collaborator-access-heading"
                  className="font-medium text-muted-foreground text-xs"
                >
                  People with access
                </h3>
                <ul className="flex flex-col">
                  {sharedWith.map((collaborator) => (
                    <li key={collaborator.subject} className="flex min-h-9 items-center gap-2">
                      <UserIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{collaborator.name}</span>
                      <AccessSelect
                        value={collaborator.access}
                        label={`${collaborator.name}'s access`}
                        disabled={!canShare}
                        onChange={(next) => void changeAccess(collaborator.subject, next)}
                      />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              disabled={!canShare}
                              aria-label={`Stop sharing with ${collaborator.name}`}
                              onClick={() => void stopSharing(collaborator.subject)}
                            />
                          }
                        >
                          <XIcon />
                        </TooltipTrigger>
                        <TooltipPopup>Stop sharing</TooltipPopup>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
