import { WS_METHODS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  IssueListEntry,
  IssueListProjectError,
  IssueListResult,
  IssueRef,
} from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { linkThreadIssue, unlinkThreadIssue } from "../operations/threadIssues.fork.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export type EnvironmentIssueRef = IssueRef & {
  readonly environmentId: EnvironmentId;
};

export type EnvironmentIssueListEntry = IssueListEntry & {
  readonly environmentId: EnvironmentId;
};

export type EnvironmentIssueListProjectError = IssueListProjectError & {
  readonly environmentId: EnvironmentId;
};

export interface IssueEnvironmentError {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}

export interface MergedIssueList {
  readonly entries: ReadonlyArray<EnvironmentIssueListEntry>;
  readonly errors: ReadonlyArray<EnvironmentIssueListProjectError>;
  readonly environmentErrors: ReadonlyArray<IssueEnvironmentError>;
  readonly truncated: boolean;
}

export function environmentIssueKey(reference: EnvironmentIssueRef): string {
  return [
    reference.environmentId,
    reference.projectId,
    reference.repository.toLowerCase(),
    reference.number,
  ].join(":");
}

export function mergeIssueLists(
  values: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  environmentErrors: ReadonlyArray<IssueEnvironmentError> = [],
): MergedIssueList {
  const entries = values
    .flatMap(([environmentId, result]) =>
      result.entries.map((entry) => ({ ...entry, environmentId })),
    )
    // Hermes lacks Array#toSorted; flatMap already yields a fresh array, so in-place sort is safe.
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const errors = values.flatMap(([environmentId, result]) =>
    result.errors.map((error) => ({ ...error, environmentId })),
  );
  return {
    entries,
    errors,
    environmentErrors,
    truncated: values.some(([, result]) => result.truncated),
  };
}

export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:list",
      tag: WS_METHODS.issuesList,
      staleTimeMs: 30_000,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:detail",
      tag: WS_METHODS.issuesDetail,
      staleTimeMs: 15_000,
    }),
    // The caller re-reads the detail it shows once this lands; the list follows on its own read.
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:github-issues:set-state",
      tag: WS_METHODS.issuesSetState,
    }),
    /** Rereads a thread's linked issues; the snapshots arrive on the thread shell stream. */
    syncThreadLinks: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:github-issues:sync-thread-links",
      tag: WS_METHODS.issuesSyncThreadLinks,
    }),
    /** Title and state behind a chat reference; refreshed rarely, read by every chip on screen. */
    reference: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:reference",
      tag: WS_METHODS.issuesReference,
      staleTimeMs: 300_000,
    }),
    /** The threads that link one issue, by its host-level key. */
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:github-issues:linked-threads",
      tag: WS_METHODS.issuesLinkedThreads,
      staleTimeMs: 15_000,
    }),
    // Thread shells carry their links, so the thread side follows on the shell stream; the
    // issue side re-reads `linkedThreads` once one of these lands.
    linkToThread: createEnvironmentCommand(runtime, {
      label: "environment-data:github-issues:link-thread",
      execute: (input: Parameters<typeof linkThreadIssue>[0]) => linkThreadIssue(input),
    }),
    unlinkFromThread: createEnvironmentCommand(runtime, {
      label: "environment-data:github-issues:unlink-thread",
      execute: (input: Parameters<typeof unlinkThreadIssue>[0]) => unlinkThreadIssue(input),
    }),
  };
}
