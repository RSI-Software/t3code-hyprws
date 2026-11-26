// Fork-only (colleague-collab): Settings → Sharing & access lists the colleagues saved on the
// chosen server, once each, with what it shares with them. Removing one ends their access on both
// servers; their devices stay listed under Authorized clients until then.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type ColleagueFork,
  type EnvironmentId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { useGT } from "gt-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";

const removeColleagueCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "remove colleague",
  tag: WS_METHODS.colleagueRemoveFork,
});

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
        colleague.threadIds.length === 0 ? (
          gt("Nothing shared with them")
        ) : (
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
  if (!served) return null;
  const colleagues = data ?? [];
  return (
    <SettingsSection {...searchableSetting("colleagues")}>
      {colleagues.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {gt("Colleagues appear here once someone accepts a shared thread.")}
        </p>
      ) : (
        colleagues.map((colleague) => (
          <ColleagueRow
            key={colleague.subject}
            environmentId={props.environmentId}
            colleague={colleague}
            canRemove={props.canRemove}
          />
        ))
      )}
    </SettingsSection>
  );
}
