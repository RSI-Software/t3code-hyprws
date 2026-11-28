// Fork-only (colleague-collab): share this thread with a collaborator, set whether their messages
// need approval, and stop sharing, all in one list of people with access. A first share mints a
// pairing link, which saves both sides as colleagues only when "Also save as colleague" is ticked;
// a collaborator already paired sees the thread live.
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
  type CollaboratorShareThreadResultFork,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, useGT, useMessages } from "gt-react";
import { CheckIcon, CopyIcon, PlusIcon, UserIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useEnvironmentQuery,
  useEnvironmentQueryRefresh,
  useEnvironmentQuerySelector,
} from "~/state/query";
import { readPreparedConnection } from "~/state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import { collaboratorShareDialogThreadAtom } from "./collaboratorShareDialogState.fork";
import { ColleagueForkDialogHostFork } from "./ColleagueFork.fork";
import { colleagueShareThreadCommand, unshareThreadCommand } from "./colleagueShare.fork";
import { shareSuggestions } from "./colleagueShare.logic.fork";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";

const isCollaboratorName = Schema.is(CollaboratorNameFork);

const shareThreadWithCollaboratorCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "share thread with collaborator",
  tag: WS_METHODS.collaboratorShareThreadFork,
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
  const messages = useMessages();
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "send" || next === "approve") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto shrink-0">
        <SelectValue>
          {(selected: CollaboratorAccessFork) => messages(ACCESS[selected].label)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
        {(["approve", "send"] as const).map((access) => (
          <SelectItem key={access} value={access}>
            <span className="flex flex-col py-0.5">
              <span>{messages(ACCESS[access].label)}</span>
              <span className="text-muted-foreground text-xs">
                {messages(ACCESS[access].detail)}
              </span>
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
  return (
    <>
      <ColleagueForkDialogHostFork />
      {threadRef === null ? null : (
        <CollaboratorShareDialog
          key={`${threadRef.environmentId}:${threadRef.threadId}`}
          threadRef={threadRef}
          onClose={() => appAtomRegistry.set(collaboratorShareDialogThreadAtom, null)}
        />
      )}
    </>
  );
}

type ShareState =
  | { readonly status: "idle" }
  | { readonly status: "creating" }
  | { readonly status: "shared"; readonly name: string }
  | ({
      readonly status: "created";
      readonly colleague: boolean;
    } & CollaboratorShareThreadResultFork)
  | { readonly status: "failed"; readonly message: string };

function CollaboratorShareDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const canShare = useAtomValue(
    shareThreadWithCollaboratorCommand.permissionAtom(threadRef.environmentId),
  );
  const share = useAtomCommand(shareThreadWithCollaboratorCommand, { reportFailure: false });
  const shareWithColleague = useAtomCommand(colleagueShareThreadCommand, { reportFailure: false });
  const colleagues =
    useEnvironmentQuery(
      colleaguesServedFork(useServerConfigs(), threadRef.environmentId)
        ? colleaguesAtom(threadRef.environmentId)
        : null,
    ).data ?? [];
  const unshare = useAtomCommand(unshareThreadCommand);
  const setAccess = useAtomCommand(setAccessCommand);
  const sharesAtom = threadSharesQuery({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const shares = useEnvironmentQuerySelector(sharesAtom, selectEnvironmentQueryData);
  const { refresh: refreshShares } = useEnvironmentQueryRefresh(sharesAtom);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(gt("collaborator link")),
  });
  const [name, setName] = useState("");
  const [asColleague, setAsColleague] = useState(false);
  const [state, setState] = useState<ShareState>({ status: "idle" });
  const trimmedName = name.trim();
  const validName = isCollaboratorName(trimmedName);

  const sharedWith = shares?.sharedWith ?? [];
  const suggestions = shareSuggestions(colleagues, {
    sharedWith,
    collaborators: shares?.collaborators ?? [],
  });

  const fail = (fallback: string, error: unknown) =>
    setState({ status: "failed", message: collaboratorErrorTextFork(error) ?? fallback });

  // A saved colleague's app already reaches this server, so no link is minted.
  const shareColleague = async (colleague: { subject: string; name: string }) => {
    setState({ status: "creating" });
    const result = await shareWithColleague({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, subject: colleague.subject },
    });
    if (result._tag === "Success") {
      setName("");
      setState({ status: "shared", name: colleague.name });
      return;
    }
    if (isAtomCommandInterrupted(result)) return setState({ status: "idle" });
    fail(
      m(msg("Could not share with {name}", { name: colleague.name })),
      squashAtomCommandFailure(result),
    );
  };

  // A typed name is a new person; only a "Shared before" pick reaches someone's grant.
  const create = async (collaboratorName: string, subject?: string) => {
    setState({ status: "creating" });
    const result = await share({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        collaboratorName,
        ...(subject === undefined ? {} : { subject }),
        ...(asColleague && { colleague: true as const }),
        ...linkBase(threadRef),
      },
    });
    refreshShares();
    if (result._tag === "Success") {
      setName("");
      setState({ status: "created", colleague: asColleague, ...result.value });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setState({ status: "idle" });
      return;
    }
    fail(gt("Could not create a collaborator link."), squashAtomCommandFailure(result));
  };

  const stopSharing = async (subject: string) => {
    await unshare({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, subject },
    });
    setState({ status: "idle" });
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
          <DialogTitle>{gt("Share with collaborator")}</DialogTitle>
          <DialogDescription>
            {gt("Collaborators follow this thread live and message the agent under their name.")}
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
                aria-label={gt("Collaborator name")}
                placeholder={gt("Name")}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <Button type="submit" size="sm" disabled={!canShare || !validName || busy}>
                {busy ? gt("Sharing...") : gt("Share")}
              </Button>
            </form>
            <label className="-mt-2 flex items-center gap-2 text-sm">
              <Checkbox
                checked={asColleague}
                disabled={busy}
                onCheckedChange={(checked) => setAsColleague(checked === true)}
              />
              {gt("Also save as colleague")}
            </label>
            {suggestions.colleagues.length > 0 ? (
              <div className="-mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                <span>{m(msg("Colleagues, no link needed:"))}</span>
                {suggestions.colleagues.map((colleague) => (
                  <Button
                    key={colleague.subject}
                    size="xs"
                    variant="outline"
                    disabled={!canShare || busy}
                    onClick={() => void shareColleague(colleague)}
                  >
                    <PlusIcon />
                    {colleague.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {suggestions.sharedBefore.length > 0 ? (
              <div className="-mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                <span>{gt("Shared before:")}</span>
                {suggestions.sharedBefore.map((collaborator) => (
                  <Button
                    key={collaborator.subject}
                    size="xs"
                    variant="outline"
                    disabled={!canShare || busy}
                    onClick={() => void create(collaborator.name, collaborator.subject)}
                  >
                    <PlusIcon />
                    {collaborator.name}
                  </Button>
                ))}
              </div>
            ) : null}
            {state.status === "shared" ? (
              <p role="status" className="text-sm">
                {m(
                  msg("{name} sees it in their sidebar now. No link needed.", { name: state.name }),
                )}
              </p>
            ) : null}
            {state.status === "created" ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm">
                  {state.colleague
                    ? gt(
                        "Send {name} this link. Opening it in T3 Code opens the thread and saves you as each other's colleagues.",
                        { name: state.collaboratorName },
                      )
                    : state.knownCollaborator
                      ? gt(
                          "{name} already sees it in their sidebar. For another device, send this link.",
                          { name: state.collaboratorName },
                        )
                      : gt("Send {name} this link to open the thread in T3 Code.", {
                          name: state.collaboratorName,
                        })}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    aria-label={gt("Collaborator link")}
                    value={state.pairingUrl}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(state.pairingUrl)}
                  >
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                    {isCopied ? gt("Copied") : gt("Copy")}
                  </Button>
                </div>
                {state.localOnly ? (
                  <p role="status" className="text-warning text-xs">
                    {gt("No public address found, so this link works only on your network.")}
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
                  {gt("People with access")}
                </h3>
                <ul className="flex flex-col">
                  {sharedWith.map((collaborator) => (
                    <li key={collaborator.subject} className="flex min-h-9 items-center gap-2">
                      <UserIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{collaborator.name}</span>
                      <AccessSelect
                        value={collaborator.access}
                        label={gt("{name}'s access", { name: collaborator.name })}
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
                              aria-label={gt("Stop sharing with {name}", {
                                name: collaborator.name,
                              })}
                              onClick={() => void stopSharing(collaborator.subject)}
                            />
                          }
                        >
                          <XIcon />
                        </TooltipTrigger>
                        <TooltipPopup>{gt("Stop sharing")}</TooltipPopup>
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
            {gt("Done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
