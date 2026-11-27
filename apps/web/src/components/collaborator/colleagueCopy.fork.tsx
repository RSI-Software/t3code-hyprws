// Fork-only (colleague-collab): keeps this device's copy of each shared thread current while its
// host is reachable, records when that was, and says so on the thread once the host is offline.
// "Offline" is upstream's: the environment's connection is not `connected`.
import { useAtomValue } from "@effect/atom-react";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironment, useEnvironments } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { environmentSnapshotAtom, useEnvironmentShellStatus } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { copySharedThreadFork, sharedThreadsToCopyFork } from "./colleagueCopy.logic.fork";

interface CopyInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const copyCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "colleague-copy:thread",
  concurrency: { mode: "serial", key: (input: CopyInput) => input.environmentId },
  execute: (input: CopyInput, registry) =>
    Option.match(
      registry.get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      {
        onNone: () => Effect.succeed(false),
        onSome: (prepared) => copySharedThreadFork(input.environmentId, prepared, input.threadId),
      },
    ),
});

// The version each copy was taken at, per environment, for this window's life.
const copiedVersions = new Map<EnvironmentId, Map<ThreadId, string>>();
const copiedFor = (environmentId: EnvironmentId) => {
  const versions = copiedVersions.get(environmentId) ?? new Map<ThreadId, string>();
  copiedVersions.set(environmentId, versions);
  return versions;
};

const LAST_SYNCED_PREFIX = "t3code:colleague-synced-fork:";
const readLastSynced = (environmentId: EnvironmentId) => {
  try {
    return getLocalStorageItem(`${LAST_SYNCED_PREFIX}${environmentId}`, Schema.Number);
  } catch {
    return null;
  }
};
const markSynced = (environmentId: EnvironmentId) => {
  try {
    setLocalStorageItem(`${LAST_SYNCED_PREFIX}${environmentId}`, Date.now(), Schema.Number);
  } catch {
    // Storage off: the offline banner leaves out the time.
  }
};

function CopyColleague(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const threads = useAtomValue(environmentSnapshotAtom(environmentId))?.threads;
  const live = useEnvironmentShellStatus(environmentId) === "live";
  const shared = threads?.some((thread) => thread.collaboratorFork !== undefined) ?? false;
  const copy = useAtomCommand(copyCommand, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the host's shared threads to this device's cache while the host is reachable.
  useEffect(() => {
    if (!live || threads === undefined) return;
    const versions = copiedFor(environmentId);
    for (const { threadId, version } of sharedThreadsToCopyFork(threads, versions)) {
      versions.set(threadId, version);
      void copy({ environmentId, threadId }).then((result) => {
        const current = result._tag === "Success" && result.value;
        if (!current && versions.get(threadId) === version) versions.delete(threadId);
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records when this host was last in sync: as it goes offline, and as this app closes.
  useEffect(() => {
    if (!live || !shared) return;
    const mark = () => markSynced(environmentId);
    mark();
    window.addEventListener("pagehide", mark);
    return () => {
      window.removeEventListener("pagehide", mark);
      mark();
    };
  }, [environmentId, live, shared]);
  return null;
}

/** Keeps a copy of every thread shared with this app, from each environment that shares one. */
export function ColleagueCopiesSyncFork() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId }) => (
    <CopyColleague key={environmentId} environmentId={environmentId} />
  ));
}

/**
 * On a shared thread whose host is offline, the connection banner says the host is offline and
 * when this copy was last in sync.
 */
export function useColleagueOfflineBannerFork(environmentId: EnvironmentId | null) {
  const gt = useGT();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const host = useEnvironment(environmentId)?.label;
  return (items: ReadonlyArray<ComposerBannerStackItem>) => {
    if (environmentId === null || host === undefined) return items;
    const lastSynced = readLastSynced(environmentId);
    const time =
      lastSynced === null
        ? null
        : formatDayAwareTimestamp(new Date(lastSynced).toISOString(), timestampFormat);
    return items.map((item) =>
      item.id === `environment-unavailable:${environmentId}`
        ? {
            ...item,
            title: gt("{environment} is offline", { environment: host }),
            description:
              time === null
                ? gt("You are reading your copy of this thread.")
                : gt("You are reading your copy, last synced {time}.", { time }),
          }
        : item,
    );
  };
}
