// Fork-only (colleague-collab): keeps this device's copy of each shared thread current while its
// host is reachable, records when each copy was last in sync, and says so on the thread once the
// host is offline. "Offline" is upstream's: the environment's connection is not `connected`.
import { useAtomValue } from "@effect/atom-react";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironment, useEnvironments } from "~/state/environments";
import { environmentSession } from "~/state/session";
import { environmentSnapshotAtom, useEnvironmentShellStatus } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import {
  copySharedThreadFork,
  sharedThreadsInSyncFork,
  sharedThreadsToCopyFork,
} from "./colleagueCopy.logic.fork";

interface CopyInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const copyCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "colleague-copy:thread",
  concurrency: { mode: "serial", key: (input: CopyInput) => input.environmentId },
  execute: (input: CopyInput, registry) => {
    const prepared = () =>
      registry.get(environmentSession.preparedConnectionValueAtom(input.environmentId));
    return Option.match(prepared(), {
      onNone: () => Effect.succeed("unavailable" as const),
      onSome: (connection) =>
        copySharedThreadFork(
          input.environmentId,
          connection,
          input.threadId,
          Effect.sync(() => Option.isSome(prepared())),
        ),
    });
  },
});

const RETRY_MS = 15_000;

const SyncedTimes = Schema.Record(Schema.String, Schema.Number);
const syncedKey = (environmentId: EnvironmentId) => `t3code:colleague-synced-fork:${environmentId}`;
const readSynced = (environmentId: EnvironmentId) => {
  try {
    return getLocalStorageItem(syncedKey(environmentId), SyncedTimes) ?? {};
  } catch {
    return {};
  }
};
const markSynced = (environmentId: EnvironmentId, threadIds: ReadonlyArray<ThreadId>) => {
  if (threadIds.length === 0) return;
  const times = { ...readSynced(environmentId) };
  for (const threadId of threadIds) times[threadId] = Date.now();
  try {
    setLocalStorageItem(syncedKey(environmentId), times, SyncedTimes);
  } catch {
    // Storage off: the offline banner leaves out the time.
  }
};

function CopyColleague(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId));
  const live = useEnvironmentShellStatus(environmentId) === "live";
  const copy = useAtomCommand(copyCommand, { reportFailure: false });
  // The version each copy was asked for and the one it holds, for this host's time in the catalog.
  const [copies] = useState(() => ({
    asked: new Map<ThreadId, string>(),
    held: new Map<ThreadId, string>(),
    retries: new Set<ReturnType<typeof setTimeout>>(),
  }));
  const [, setRetries] = useState(0);
  const latestThreads = useRef(snapshot?.threads ?? []);
  const threads =
    snapshot === null || snapshot === undefined
      ? undefined
      : [...snapshot.threads, ...snapshot.archivedThreads];
  const shared = threads?.some((thread) => thread.collaboratorFork !== undefined) ?? false;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the host's shared threads to this device's cache while the host is reachable.
  useEffect(() => {
    if (!live || threads === undefined) return;
    latestThreads.current = threads;
    for (const { threadId, version } of sharedThreadsToCopyFork(threads, copies.asked)) {
      copies.asked.set(threadId, version);
      void copy({ environmentId, threadId }).then((result) => {
        const outcome = result._tag === "Success" ? result.value : "unavailable";
        if (outcome === "current") {
          copies.held.set(threadId, version);
          markSynced(environmentId, [threadId]);
        } else if (outcome === "unavailable" && copies.asked.get(threadId) === version) {
          copies.asked.delete(threadId);
          const retry = setTimeout(() => {
            copies.retries.delete(retry);
            setRetries((count) => count + 1);
          }, RETRY_MS);
          copies.retries.add(retry);
        }
      });
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records which copies were in sync as this host goes offline or this app closes.
  useEffect(() => {
    if (!live || !shared) return;
    const mark = () =>
      markSynced(environmentId, sharedThreadsInSyncFork(latestThreads.current, copies.held));
    window.addEventListener("pagehide", mark);
    return () => {
      window.removeEventListener("pagehide", mark);
      mark();
    };
  }, [copies, environmentId, live, shared]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a host leaving this app stops its pending retries.
  useEffect(
    () => () => {
      for (const retry of copies.retries) clearTimeout(retry);
      copies.retries.clear();
    },
    [copies],
  );
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
export function useColleagueOfflineBannerFork(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const gt = useGT();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const host = useEnvironment(environmentId)?.label;
  return (items: ReadonlyArray<ComposerBannerStackItem>) => {
    if (environmentId === null || threadId === null || host === undefined) return items;
    const lastSynced = readSynced(environmentId)[threadId];
    const time =
      lastSynced === undefined
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
