import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
  type TerminalBufferState,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId, type EnvironmentId, type TerminalAttachInput } from "@t3tools/contracts";
import { useMemo, useRef } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

export interface RetainedTerminalAttachmentState {
  readonly identity: string | null;
  readonly source: TerminalBufferState | null;
  readonly value: TerminalBufferState;
  readonly error: string | null;
}

export const EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE: RetainedTerminalAttachmentState =
  Object.freeze({
    identity: null,
    source: null,
    value: EMPTY_TERMINAL_BUFFER_STATE,
    error: null,
  });

export function updateRetainedTerminalAttachment(
  current: RetainedTerminalAttachmentState,
  identity: string | null,
  source: TerminalBufferState | null,
  error: string | null,
): RetainedTerminalAttachmentState {
  if (identity === null) return EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE;
  const retained =
    current.identity === identity
      ? current
      : {
          identity,
          source: null,
          value: EMPTY_TERMINAL_BUFFER_STATE,
          error: null,
        };

  let next = retained;
  if (source !== null && source !== retained.source) {
    const versionDelta =
      retained.source === null
        ? Math.max(1, source.version)
        : source.version > retained.source.version
          ? source.version - retained.source.version
          : 1;
    next = {
      identity,
      source,
      value: { ...source, version: retained.value.version + versionDelta },
      error: null,
    };
  }

  if (error !== null && error !== next.error) {
    next = { ...next, error };
  }
  return next;
}

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
  readonly enabled?: boolean;
}): TerminalSessionState {
  const enabled = input.enabled ?? true;
  const attach = useEnvironmentQuery(
    enabled && input.environmentId !== null && input.terminal !== null
      ? terminalEnvironment.attach({
          environmentId: input.environmentId,
          input: input.terminal,
        })
      : null,
  );
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  const attachmentIdentity =
    input.environmentId !== null && input.terminal !== null
      ? JSON.stringify([input.environmentId, input.terminal.threadId, input.terminal.terminalId])
      : null;
  const retainedAttachmentRef = useRef(EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE);
  const retainedAttachment = updateRetainedTerminalAttachment(
    retainedAttachmentRef.current,
    attachmentIdentity,
    attach.data ?? null,
    attach.error ?? null,
  );
  retainedAttachmentRef.current = retainedAttachment;

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }
    const summary =
      metadata.data?.find(
        (terminal) =>
          terminal.threadId === input.terminal?.threadId &&
          terminal.terminalId === input.terminal?.terminalId,
      ) ?? null;
    const state = combineTerminalSessionState(summary, retainedAttachment.value);
    return retainedAttachment.error !== null
      ? { ...state, error: retainedAttachment.error, status: "error" }
      : state;
  }, [input.environmentId, input.terminal, metadata.data, retainedAttachment]);
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(() => {
    if (input.environmentId === null) {
      return [];
    }
    return (metadata.data ?? [])
      .filter((summary) => input.threadId === null || summary.threadId === input.threadId)
      .map((summary) => ({
        target: {
          environmentId: input.environmentId!,
          threadId: ThreadId.make(summary.threadId),
          terminalId: summary.terminalId,
        },
        state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
      }))
      .sort((left, right) =>
        left.target.terminalId.localeCompare(right.target.terminalId, undefined, {
          numeric: true,
        }),
      );
  }, [input.environmentId, input.threadId, metadata.data]);
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  return selectRunningSubprocessTerminalIds(useKnownTerminalSessions(input));
}
