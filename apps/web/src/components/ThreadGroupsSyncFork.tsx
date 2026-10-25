// Fork-only (thread-ordering): follows each connected environment's thread
// groups. Mounted once by `__root.tsx` through the marked hook; an upstream
// server lacks the capability and is never asked.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useServerConfigs } from "../state/entities";
import { useEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import {
  receiveThreadGroupsSnapshotFork,
  retainThreadGroupEnvironmentsFork,
  threadGroupEnvironment,
} from "../state/threadGroups";

function EnvironmentThreadGroupsSync(props: { readonly environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(
    threadGroupEnvironment.groups({ environmentId: props.environmentId, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the environment's thread-groups query snapshot into the external thread-group store.
  useEffect(() => {
    if (data !== null) receiveThreadGroupsSnapshotFork(props.environmentId, data);
  }, [data, props.environmentId]);
  return null;
}

export function ThreadGroupsSyncFork() {
  const environmentIds = useEnvironmentIds();
  const configs = useServerConfigs();
  const served = environmentIds.filter(
    (environmentId) =>
      configs.get(environmentId)?.environment.capabilities.threadGroupsFork === true,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes the external thread-group store to served environments; renders only when environments or configs change.
  useEffect(() => retainThreadGroupEnvironmentsFork(new Set(served)));
  return served.map((environmentId) => (
    <EnvironmentThreadGroupsSync key={environmentId} environmentId={environmentId} />
  ));
}
