// Fork-only (colleague-collab): saved colleagues on this app's own server, and the sync that keeps
// each colleague's environment in the catalog so their shares appear live. Mounted once by
// `__root.tsx`; a server without the capability is never asked.
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type ColleagueFork, type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { createElement, useEffect, useRef } from "react";

import { connectPairing } from "~/connection/onboarding";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs } from "~/state/entities";
import {
  readEnvironment,
  readPrimaryEnvironmentId,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { environmentServerConfigsAtom } from "~/state/server";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { waitForAtomValue } from "~/state/waitForAtomValue";
import { stackedThreadToast, toastManager } from "../ui/toast";

const colleaguesFamily = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "colleagues:subscribe",
  tag: WS_METHODS.colleagueSubscribeFork,
});

/** @public The colleagues saved on `environmentId`'s server, live. */
export const colleaguesAtom = (environmentId: EnvironmentId) =>
  colleaguesFamily({ environmentId, input: {} });

/** @public Whether `environmentId`'s server keeps saved colleagues. */
export const colleaguesServedFork = (
  configs: ReadonlyMap<
    EnvironmentId,
    { readonly environment?: { readonly capabilities: { readonly colleaguesFork?: boolean } } }
  >,
  environmentId: EnvironmentId | null,
) =>
  environmentId !== null &&
  configs.get(environmentId)?.environment?.capabilities.colleaguesFork === true;

const pairClientCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:pair-client",
  tag: WS_METHODS.colleaguePairClientFork,
});
const inviteCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:invite",
  tag: WS_METHODS.colleagueInviteFork,
});
const saveCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:save",
  tag: WS_METHODS.colleagueSaveFork,
});
const connectCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "colleagues:connect",
  tag: WS_METHODS.colleagueConnectFork,
});

// The sharer's server config arrives after pairing; past this, an older server is left alone.
const SHARER_CONFIG_TIMEOUT_MS = 15_000;

const linkBase = (environmentId: EnvironmentId) => {
  const linkBaseUrl = readPreparedConnection(environmentId)?.httpBaseUrl;
  return linkBaseUrl === undefined ? {} : { linkBaseUrl };
};

/**
 * Returns the accept that runs once a shared thread's environment is paired: each server saves
 * the other as a colleague. A browser that is only the sharer's guest has no server of its own.
 */
export function useSaveColleagueFork() {
  const gt = useGT();
  const quiet = { reportFailure: false } as const;
  const invite = useAtomCommand(inviteCommand, quiet);
  const save = useAtomCommand(saveCommand, quiet);
  const connect = useAtomCommand(connectCommand, quiet);
  return async (sharer: EnvironmentId) => {
    const own = readPrimaryEnvironmentId();
    if (own === null || own === sharer) return;
    if (!colleaguesServedFork(appAtomRegistry.get(environmentServerConfigsAtom), own)) return;
    const sharerKnown = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentServerConfigsAtom,
      predicate: (configs) => configs.has(sharer),
      timeoutMs: SHARER_CONFIG_TIMEOUT_MS,
    });
    const configs = appAtomRegistry.get(environmentServerConfigsAtom);
    if (!sharerKnown || !colleaguesServedFork(configs, sharer)) return;
    const name = readEnvironment(sharer)?.label ?? sharer;
    const invited = await invite({
      environmentId: own,
      input: { environmentId: sharer, name, ...linkBase(own) },
    });
    const saved =
      invited._tag === "Success"
        ? await save({
            environmentId: sharer,
            input: { grant: invited.value, ...linkBase(sharer) },
          })
        : invited;
    const connected =
      invited._tag === "Success" && saved._tag === "Success"
        ? await connect({
            environmentId: own,
            input: { subject: invited.value.subject, name, grant: saved.value },
          })
        : saved;
    if (connected._tag === "Success" || isAtomCommandInterrupted(connected)) return;
    const error = squashAtomCommandFailure(connected);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not save {name} as a colleague", { name }),
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };
}

// The colleague list each attach was tried with; a newer list (a change, or a resubscribe after a
// reconnect) retries one that failed, and a re-save (new savedAt) is a new attach.
const attempted = new Map<string, ReadonlyArray<ColleagueFork>>();

function AttachColleagues(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { data } = useEnvironmentQuery(colleaguesAtom(props.environmentId));
  // Colleagues already saved when this app loaded; any other is new and confirmed with a toast.
  const seen = useRef<Set<string> | null>(null);
  const { environments } = useEnvironments();
  const pairClient = useAtomCommand(pairClientCommand, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const known = new Set(environments.map((environment) => environment.environmentId));
  const missing = (data ?? []).filter(
    (colleague) =>
      !known.has(colleague.environmentId) &&
      attempted.get(`${colleague.subject}:${colleague.savedAt}`) !== data,
  );
  const attach = async (colleague: ColleagueFork, list: ReadonlyArray<ColleagueFork>) => {
    attempted.set(`${colleague.subject}:${colleague.savedAt}`, list);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs the external environment catalog with saved colleagues it lacks, and announces new ones.
  useEffect(() => {
    if (data === null) return;
    const saves = data.map((colleague) => `${colleague.subject}:${colleague.savedAt}`);
    for (const colleague of seen.current === null ? [] : data) {
      if (seen.current?.has(`${colleague.subject}:${colleague.savedAt}`)) continue;
      toastManager.add({
        type: "success",
        title: gt("Saved {name} as a colleague", { name: colleague.name }),
        description: gt("Threads you share with each other now appear without a new link."),
      });
    }
    seen.current = new Set(saves);
    for (const colleague of missing) void attach(colleague, data);
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
