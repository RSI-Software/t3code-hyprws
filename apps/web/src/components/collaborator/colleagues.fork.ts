// Fork-only (colleague-collab): saved colleagues on this app's own server, and the sync that keeps
// each colleague's environment in the catalog so their shares appear live. Mounted once by
// `__root.tsx`; a server without the capability is never asked.
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type ColleagueFork, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { createElement, useEffect } from "react";

import { connectPairing } from "~/connection/onboarding";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useServerConfigs } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const colleaguesFamily = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "colleagues:subscribe",
  tag: WS_METHODS.colleagueSubscribeFork,
});

/** @public The colleagues saved on `environmentId`'s server, live. */
export const colleaguesAtom = (environmentId: EnvironmentId) =>
  colleaguesFamily({ environmentId, input: {} });

/** @public Whether `environmentId`'s server keeps saved colleagues. */
export const colleaguesServedFork = (
  configs: ReturnType<typeof useServerConfigs>,
  environmentId: EnvironmentId | null,
) =>
  environmentId !== null &&
  configs.get(environmentId)?.environment.capabilities.colleaguesFork === true;

const pairClientCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:pair-client",
  tag: WS_METHODS.colleaguePairClientFork,
});

// One attempt per saved colleague per page load; a re-save (new savedAt) tries again.
const attempted = new Set<string>();

function AttachColleagues(props: { readonly environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(colleaguesAtom(props.environmentId));
  const { environments } = useEnvironments();
  const pairClient = useAtomCommand(pairClientCommand, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const known = new Set(environments.map((environment) => environment.environmentId));
  const missing = (data ?? []).filter(
    (colleague) =>
      !known.has(colleague.environmentId) &&
      !attempted.has(`${colleague.subject}:${colleague.savedAt}`),
  );
  const attach = async (colleague: ColleagueFork) => {
    attempted.add(`${colleague.subject}:${colleague.savedAt}`);
    const pairing = await pairClient({
      environmentId: props.environmentId,
      input: { subject: colleague.subject },
    });
    if (pairing._tag === "Failure") return;
    await connect({
      host: pairing.value.url,
      pairingCode: pairing.value.credential,
      expectedEnvironmentId: pairing.value.environmentId,
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs the external environment catalog with saved colleagues it lacks.
  useEffect(() => {
    for (const colleague of missing) void attach(colleague);
  });
  return null;
}

/** Adds each saved colleague's environment the catalog lacks, through a one-time client pairing. */
export function ColleaguesAttachSyncFork() {
  const primary = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  if (primary === null || !colleaguesServedFork(configs, primary)) return null;
  return createElement(AttachColleagues, { environmentId: primary });
}
