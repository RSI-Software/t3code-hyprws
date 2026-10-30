// Fork-only (colleague-collab): share this thread with a colleague, see who has it, and stop
// sharing. A first share mints a pairing link; a colleague already paired sees it live.
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  selectEnvironmentQueryData,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ColleagueNameFork, type ScopedThreadRef, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQueryRefresh, useEnvironmentQuerySelector } from "~/state/query";
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
import { colleagueShareDialogThreadAtom } from "./colleagueShareDialogState.fork";

const isColleagueName = Schema.is(ColleagueNameFork);

const shareThreadWithColleagueCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "share thread with colleague",
  tag: WS_METHODS.colleagueShareThreadFork,
});

const unshareThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "stop sharing thread with colleague",
  tag: WS_METHODS.colleagueUnshareThreadFork,
});

const threadSharesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:colleague:thread-shares",
  tag: WS_METHODS.colleagueThreadSharesFork,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export function ColleagueShareDialogHostFork() {
  const threadRef = useAtomValue(colleagueShareDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ColleagueShareDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(colleagueShareDialogThreadAtom, null)}
    />
  );
}

type ShareState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | {
      readonly status: "created";
      readonly name: string;
      readonly appLink: string;
      readonly knownColleague: boolean;
    }
  | { readonly status: "failed"; readonly message: string };

function ColleagueShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const canShare = useAtomValue(
    shareThreadWithColleagueCommand.permissionAtom(threadRef.environmentId),
  );
  const share = useAtomCommand(shareThreadWithColleagueCommand, { reportFailure: false });
  const unshare = useAtomCommand(unshareThreadCommand);
  const sharesAtom = threadSharesQuery({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const shares = useEnvironmentQuerySelector(sharesAtom, selectEnvironmentQueryData);
  const { refresh: refreshShares } = useEnvironmentQueryRefresh(sharesAtom);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "colleague link" });
  const [name, setName] = useState("");
  const [state, setState] = useState<ShareState>({ status: "idle" });
  const trimmedName = name.trim();
  const validName = isColleagueName(trimmedName);

  const sharedWith = shares?.sharedWith ?? [];
  const suggestions = (shares?.colleagues ?? []).filter(
    (colleague) => !sharedWith.some((shared) => shared.subject === colleague.subject),
  );

  const create = async (colleagueName: string) => {
    setState({ status: "creating" });
    const result = await share({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, colleagueName },
    });
    refreshShares();
    if (result._tag === "Success") {
      setState({ status: "created", name: colleagueName, ...result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    const error = squashAtomCommandFailure(result);
    setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Could not create a colleague link.",
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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "creating") onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share to colleague</DialogTitle>
          <DialogDescription>
            A colleague you have shared with before sees this thread in their sidebar right away.
            Someone new gets a link that pairs their T3 Code app. Their messages run here, marked
            with their name.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {sharedWith.length > 0 ? (
              <ul aria-label="Shared with" className="flex flex-col gap-1">
                {sharedWith.map((colleague) => (
                  <li key={colleague.subject} className="flex items-center justify-between gap-2">
                    <span className="text-sm">Shared with {colleague.name}</span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void stopSharing(colleague.subject)}
                    >
                      Stop sharing
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {state.status === "created" ? (
              <>
                {state.knownColleague ? (
                  <p className="text-sm">
                    {state.name} is already paired; it is in their sidebar now. For a new device,
                    send this link:
                  </p>
                ) : null}
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    aria-label="Colleague link"
                    value={state.appLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(state.appLink)}
                  >
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (validName) void create(trimmedName);
                  }}
                >
                  <Input
                    autoFocus
                    aria-label="Colleague name"
                    placeholder="Colleague name"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                  />
                </form>
                {suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((colleague) => (
                      <Button
                        key={colleague.subject}
                        size="xs"
                        variant="outline"
                        disabled={!canShare || state.status === "creating"}
                        onClick={() => void create(colleague.name)}
                      >
                        Share with {colleague.name}
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
