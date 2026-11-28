// Fork-only (colleague-collab): Settings → Sharing & access lists the colleagues saved on the
// chosen server, once each, with what they read (team projects and threads shared with them),
// and invites one by a colleague-only link. Removing one ends their access on both servers;
// their devices stay listed under Authorized clients until then.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type ColleagueFork,
  type ColleagueInviteLinkResultFork,
  CollaboratorNameFork,
  type EnvironmentId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useProjects, useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { collaboratorErrorTextFork } from "./collaboratorErrors.fork";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";

const removeColleagueCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "remove colleague",
  tag: WS_METHODS.colleagueRemoveFork,
});
const inviteLinkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:invite-link",
  tag: WS_METHODS.colleagueInviteLinkFork,
});

const isCollaboratorName = Schema.is(CollaboratorNameFork);

type InviteState =
  | { readonly status: "closed" }
  | { readonly status: "open"; readonly error?: string }
  | { readonly status: "creating" }
  | ({ readonly status: "created" } & ColleagueInviteLinkResultFork);

/** A link that saves the host and its opener as each other's colleagues and shares no thread. */
function InviteColleagueRow(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const canInvite = useAtomValue(inviteLinkCommand.permissionAtom(props.environmentId));
  const createLink = useAtomCommand(inviteLinkCommand, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(gt("colleague invite link")),
  });
  const [name, setName] = useState("");
  const [state, setState] = useState<InviteState>({ status: "closed" });
  const trimmedName = name.trim();
  if (!canInvite) return null;
  const create = async () => {
    setState({ status: "creating" });
    const linkBaseUrl = readPreparedConnection(props.environmentId)?.httpBaseUrl;
    const result = await createLink({
      environmentId: props.environmentId,
      input: { name: trimmedName, ...(linkBaseUrl === undefined ? {} : { linkBaseUrl }) },
    });
    if (result._tag === "Success") {
      setName("");
      return setState({ status: "created", ...result.value });
    }
    if (isAtomCommandInterrupted(result)) return setState({ status: "open" });
    setState({
      status: "open",
      error:
        collaboratorErrorTextFork(squashAtomCommandFailure(result)) ??
        gt("Could not create a colleague invite."),
    });
  };
  return (
    <SettingsRow
      title={gt("Invite colleague")}
      description={gt("A link that saves you as each other's colleagues. It shares no thread.")}
      control={
        // After a link is made, the same button starts the next invite.
        state.status === "closed" || state.status === "created" ? (
          <Button size="sm" variant="outline" onClick={() => setState({ status: "open" })}>
            {gt("Invite colleague")}
          </Button>
        ) : undefined
      }
    >
      {state.status === "closed" ? null : state.status === "created" ? (
        <div className="flex flex-col gap-2 pt-2">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label={gt("Colleague invite link")}
              value={state.pairingUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" variant="outline" onClick={() => copyToClipboard(state.pairingUrl)}>
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
      ) : (
        <form
          className="flex flex-col gap-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (isCollaboratorName(trimmedName) && state.status === "open") void create();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              aria-label={gt("Colleague name")}
              placeholder={gt("Name")}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!isCollaboratorName(trimmedName) || state.status === "creating"}
            >
              {gt("Create link")}
            </Button>
          </div>
          {state.status === "open" && state.error ? (
            <p role="alert" className="text-destructive text-xs">
              {state.error}
            </p>
          ) : null}
        </form>
      )}
    </SettingsRow>
  );
}

// The shell keeps a loaded thread's title live; the title read covers archived and unloaded ones.
function SharedThreadTitle(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string | undefined;
  readonly settled: boolean;
}) {
  const gt = useGT();
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const title = shell?.title ?? props.title;
  return <li className="truncate">{title ?? (props.settled ? gt("Untitled thread") : null)}</li>;
}

function ColleagueRow(props: {
  readonly environmentId: EnvironmentId;
  readonly colleague: ColleagueFork;
  readonly teamProjects: ReadonlyArray<string>;
  readonly canRemove: boolean;
}) {
  const gt = useGT();
  const { colleague } = props;
  const removeColleague = useAtomCommand(removeColleagueCommand);
  const titles = useEnvironmentQuery(
    colleague.threadIds.length === 0
      ? null
      : orchestrationEnvironment.threadTitles({
          environmentId: props.environmentId,
          input: { threadIds: colleague.threadIds },
        }),
  );
  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      gt(
        "Remove {name}?\nThey lose every thread shared with them, and their machine forgets yours.",
        { name: colleague.name },
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const result = await removeColleague({
      environmentId: props.environmentId,
      input: { subject: colleague.subject },
    });
    if (result._tag === "Failure") return;
    toastManager.add(
      result.value.endedThere
        ? {
            type: "success",
            title: gt("Removed {name} on both machines", { name: colleague.name }),
          }
        : {
            type: "warning",
            title: gt("Removed here; {name}'s machine was unreachable", { name: colleague.name }),
            description: gt("Their access here has ended. Their machine still lists you."),
          },
    );
  };
  return (
    <SettingsRow
      title={colleague.name}
      description={
        colleague.threadIds.length === 0 && props.teamProjects.length === 0 ? (
          gt("Nothing shared with them")
        ) : (
          <>
            {props.teamProjects.length === 0 ? null : (
              <span className="block">
                {gt("Reads all threads in team projects: {projects}", {
                  projects: props.teamProjects.join(", "),
                })}
              </span>
            )}
            {colleague.threadIds.length === 0 ? null : (
              <ul aria-label={gt("Threads shared with {name}", { name: colleague.name })}>
                {colleague.threadIds.map((threadId) => (
                  <SharedThreadTitle
                    key={threadId}
                    environmentId={props.environmentId}
                    threadId={threadId}
                    title={titles.data?.[threadId]}
                    settled={titles.isSuccess || titles.error !== null}
                  />
                ))}
              </ul>
            )}
          </>
        )
      }
      control={
        props.canRemove ? (
          <Button size="sm" variant="outline" onClick={() => void remove()}>
            {gt("Remove", { $context: "verb, removes a saved colleague" })}
          </Button>
        ) : undefined
      }
    />
  );
}

export function ColleaguesSettingsFork(props: {
  readonly environmentId: EnvironmentId;
  readonly canRemove: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const served = colleaguesServedFork(useServerConfigs(), props.environmentId);
  const { data } = useEnvironmentQuery(served ? colleaguesAtom(props.environmentId) : null);
  // Every saved colleague reads every thread of a team project here, archived ones included.
  const teamProjects = useProjects()
    .filter((project) => project.environmentId === props.environmentId && project.teamFork)
    .map((project) => project.title);
  if (!served) return null;
  const colleagues = data ?? [];
  return (
    <SettingsSection {...searchableSetting("colleagues")}>
      <InviteColleagueRow environmentId={props.environmentId} />
      {colleagues.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {gt("Colleagues appear here once someone accepts your colleague invite.")}
        </p>
      ) : (
        colleagues.map((colleague) => (
          <ColleagueRow
            key={colleague.subject}
            environmentId={props.environmentId}
            colleague={colleague}
            teamProjects={teamProjects}
            canRemove={props.canRemove}
          />
        ))
      )}
    </SettingsSection>
  );
}
