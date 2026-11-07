// Fork-only (colleague-collab): share this thread with a collaborator, set whether their messages
// need approval, and stop sharing. A first share mints a pairing link; a collaborator already
// paired sees the thread live.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
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
import { CheckIcon, CopyIcon } from "lucide-react";
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

const setAccessCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "change collaborator access",
  tag: WS_METHODS.collaboratorSetAccessFork,
});

const ACCESS_LABELS: Record<CollaboratorAccessFork, string> = {
  approve: "You approve messages",
  send: "Sends directly",
};

function AccessSelect({
  value,
  label,
  disabled,
  onChange,
}: {
  readonly value: CollaboratorAccessFork;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onChange: (access: CollaboratorAccessFork) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled ?? false}
      onValueChange={(next) => {
        if (next === "send" || next === "approve") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto shrink-0">
        <SelectValue>{(selected: CollaboratorAccessFork) => ACCESS_LABELS[selected]}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {(["approve", "send"] as const).map((access) => (
          <SelectItem key={access} value={access}>
            {ACCESS_LABELS[access]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const threadSharesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:collaborator:thread-shares",
  tag: WS_METHODS.collaboratorThreadSharesFork,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

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
  const [access, setNewAccess] = useState<CollaboratorAccessFork>("approve");
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
      input: { threadId: threadRef.threadId, collaboratorName, access, ...linkBase(threadRef) },
    });
    refreshShares();
    if (result._tag === "Success") {
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
    refreshShares();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "creating") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share with collaborator</DialogTitle>
          <DialogDescription>
            They follow the thread live and message the agent under their name. Someone new gets a
            link that pairs their T3 Code app; anyone you shared with before sees it right away.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {sharedWith.length > 0 ? (
              <ul aria-label="Shared with" className="flex flex-col gap-1">
                {sharedWith.map((collaborator) => (
                  <li key={collaborator.subject} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{collaborator.name}</span>
                    <AccessSelect
                      value={collaborator.access}
                      label={`${collaborator.name}'s access`}
                      disabled={!canShare}
                      onChange={(next) => void changeAccess(collaborator.subject, next)}
                    />
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={!canShare}
                      onClick={() => void stopSharing(collaborator.subject)}
                    >
                      Stop sharing
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {state.status === "created" ? (
              <>
                {state.knownCollaborator ? (
                  <p className="text-sm">
                    {state.name} is already paired; it is in their sidebar now. For a new device,
                    send this link:
                  </p>
                ) : null}
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
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <form
                    className="min-w-0 flex-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (validName) void create(trimmedName);
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label="Collaborator name"
                      placeholder="Collaborator name"
                      value={name}
                      onChange={(event) => setName(event.currentTarget.value)}
                    />
                  </form>
                  <AccessSelect
                    value={access}
                    label="New collaborator's access"
                    onChange={setNewAccess}
                  />
                </div>
                {suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((collaborator) => (
                      <Button
                        key={collaborator.subject}
                        size="xs"
                        variant="outline"
                        disabled={!canShare || state.status === "creating"}
                        onClick={() => void create(collaborator.name)}
                      >
                        Share with {collaborator.name}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
            {state.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {state.status === "created" ? (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={state.status === "creating"}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void create(trimmedName)}
                disabled={!canShare || !validName || state.status === "creating"}
              >
                {state.status === "creating" ? "Sharing..." : "Share"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
