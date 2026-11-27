// Fork-only (colleague-collab): saved colleagues on this app's own server, and the sync that keeps
// each colleague's environment in the catalog so their shares appear live. Mounted once by
// `__root.tsx`; a server without the capability is never asked.
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type ColleagueFork, EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { createElement, useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { connectPairing } from "~/connection/onboarding";
import { connectionAtomRuntime } from "~/connection/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
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
import { createColleagueAttacherFork } from "./colleagueAttach.fork";
import { createColleagueReconcilerFork, type KnownColleagueFork } from "./colleagueReconcile.fork";

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
// How often a colleague whose attach failed is tried again while their server stays down.
const COLLEAGUE_RETRY_MS = 15_000;

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

const attachColleagues = createColleagueAttacherFork();

// The device's last colleague list, so an app closed during a removal still forgets them.
const LastColleagues = Schema.Array(
  Schema.Struct({ environmentId: EnvironmentId, name: Schema.String }),
);
const LAST_COLLEAGUES_PREFIX = "t3code:colleagues-fork:";
const readLastColleagues = (key: string) => {
  try {
    return getLocalStorageItem(key, LastColleagues) ?? [];
  } catch {
    return [];
  }
};
// Read as this window starts, before its catalog loads: its first colleague list can arrive after
// another window has already cleaned up and rewritten the stored one.
const startupColleagues = (() => {
  try {
    return new Map(
      Object.keys(localStorage)
        .filter((key) => key.startsWith(LAST_COLLEAGUES_PREFIX))
        .map((key) => [key, readLastColleagues(key)] as const),
    );
  } catch {
    return new Map<string, ReadonlyArray<KnownColleagueFork>>();
  }
})();
const windowColleagueReconciler = (environmentId: EnvironmentId) => {
  const key = `${LAST_COLLEAGUES_PREFIX}${environmentId}`;
  return createColleagueReconcilerFork(startupColleagues.get(key) ?? [], (list) => {
    try {
      setLocalStorageItem(key, list, LastColleagues);
    } catch {
      // Storage off: removals still apply live, only not across a reload.
    }
  });
};

function AttachColleagues(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { data } = useEnvironmentQuery(colleaguesAtom(props.environmentId));
  // Colleagues already saved when this app loaded; any other is new and confirmed with a toast.
  const seen = useRef<Set<string> | null>(null);
  const reconciled = useRef<ReadonlyArray<ColleagueFork> | null>(null);
  const [reconcile] = useState(() => windowColleagueReconciler(props.environmentId));
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const { environments, isReady } = useEnvironments();
  const pairClient = useAtomCommand(pairClientCommand, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const known = new Set(environments.map((environment) => environment.environmentId));
  const unattached =
    isReady && (data ?? []).some((colleague) => !known.has(colleague.environmentId));
  const [retry, setRetry] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a colleague's server gives no sign it is back, so an unattached one is tried again on a slow timer.
  useEffect(() => {
    if (!unattached) return;
    const timer = setInterval(() => setRetry((count) => count + 1), COLLEAGUE_RETRY_MS);
    return () => clearInterval(timer);
  }, [unattached]);
  const attach = async (colleague: ColleagueFork) => {
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs the external environment catalog with saved colleagues: adds new ones, forgets removed ones.
  useEffect(() => {
    if (data === null || !isReady) return;
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
    void attachColleagues({ colleagues: data, known, retry, attach });
    if (reconciled.current === data) return;
    reconciled.current = data;
    void reconcile({
      current: data,
      known,
      remove: async (environmentId) => (await removeEnvironment(environmentId))._tag === "Success",
      forgotten: (colleague) =>
        toastManager.add({
          type: "info",
          title: gt("{name} is no longer a colleague", { name: colleague.name }),
          description: gt("Threads shared between you are gone from this app."),
        }),
    });
  });
  return null;
}

/**
 * Adds each saved colleague's environment the catalog lacks, through a one-time client pairing,
 * and forgets one whose colleague was removed.
 */
export function ColleaguesAttachSyncFork() {
  const primary = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  if (primary === null || !colleaguesServedFork(configs, primary)) return null;
  return createElement(AttachColleagues, { key: primary, environmentId: primary });
}
