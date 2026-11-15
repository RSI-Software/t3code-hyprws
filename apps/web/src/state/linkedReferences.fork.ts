import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { issueEnvironment } from "./issues";
import {
  linkedReferenceIndex,
  linkedReferenceKey,
  type LinkedReference,
} from "./linkedReferenceIndex.fork";
import { environmentThreadShells } from "./threads";
import { useAtomCommand } from "./use-atom-command";

// The servers' own freshness window; past it a snapshot the sweeps skip (a closed issue, a closed
// or settled pull request) may be wrong, so a chip showing it asks for one shared reread.
const STALE_AFTER_MS = 5 * 60 * 1_000;

// A reader reporting a state makes the server reread that pull request for every linked thread.
const reportPullRequestState = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "linked-reference:report-pull-request-state",
  tag: WS_METHODS.pullRequestsReportState,
});

const linkedReferenceIndexAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    linkedReferenceIndex(get(environmentThreadShells.environmentThreadsAtom(environmentId))),
  ).pipe(Atom.withLabel(`linked-reference-index:${environmentId}`)),
);

// One atom per reference, compared by value, so a shell update re-renders only the chips it changed.
const linkedReferenceAtom = Atom.family((key: `${EnvironmentId}|${string}`) => {
  const [environmentId, reference] = key.split("|") as [EnvironmentId, string];
  return Atom.make(
    (get): LinkedReference | null =>
      get(linkedReferenceIndexAtom(environmentId)).get(reference) ?? null,
  ).pipe(Atom.withEquality(Equal.equals), Atom.withLabel(`linked-reference:${key}`));
});

const NONE_ATOM = Atom.make<LinkedReference | null>(null).pipe(
  Atom.withLabel("linked-reference:none"),
);

export function useLinkedReference(
  environmentId: EnvironmentId | null,
  repository: string,
  number: number | null,
): LinkedReference | null {
  return useAtomValue(
    environmentId === null || number === null
      ? NONE_ATOM
      : linkedReferenceAtom(`${environmentId}|${linkedReferenceKey(repository, number)}`),
  );
}

/** Asks the server to reread a stale linked snapshot; the fresh one arrives on the shell stream. */
export function useSyncStaleLinkedReference(
  environmentId: EnvironmentId | null,
  linked: LinkedReference | null,
) {
  const syncIssues = useAtomCommand(issueEnvironment.syncThreadLinks, { reportFailure: false });
  const reportState = useAtomCommand(reportPullRequestState, { reportFailure: false });
  const sync = useEffectEvent((environmentId: EnvironmentId, linked: LinkedReference) => {
    if (Date.now() - Date.parse(linked.syncedAt) < STALE_AFTER_MS) return;
    const { summary } = linked;
    if (summary.kind === "issue") {
      void syncIssues({ environmentId, input: { threadId: linked.threadId, scope: "stale" } });
    } else if (summary.state !== "merged") {
      void reportState({
        environmentId,
        input: {
          reference: {
            projectId: linked.projectId,
            host: "github.com",
            repository: linked.repository,
            number: linked.number,
          },
          state: summary.state === "closed" ? "closed" : "open",
          isDraft: summary.state === "draft",
        },
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server once per snapshot; a fresh one changes `syncedAt` and is skipped.
  useEffect(() => {
    if (environmentId !== null && linked !== null) sync(environmentId, linked);
  }, [environmentId, linked]);
}
