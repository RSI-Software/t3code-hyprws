import {
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, TerminalAttachInput } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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

export function terminalAttachmentIdentity(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
}): string | null {
  return input.environmentId !== null && input.terminal !== null
    ? JSON.stringify([input.environmentId, input.terminal.threadId, input.terminal.terminalId])
    : null;
}

// Keep stream retention outside the upstream metadata/index module. A hidden
// surface releases its attach query while this state retains its last bounded
// buffer; returning demand can replace the stream without regressing versions.
export function useRetainedTerminalAttachment(
  input: {
    readonly environmentId: EnvironmentId | null;
    readonly terminal: TerminalAttachInput | null;
  },
  attach: { readonly data: TerminalBufferState | null; readonly error: string | null },
): RetainedTerminalAttachmentState {
  const [committed, setCommitted] = useState(EMPTY_RETAINED_TERMINAL_ATTACHMENT_STATE);
  const retained = updateRetainedTerminalAttachment(
    committed,
    terminalAttachmentIdentity(input),
    attach.data,
    attach.error,
  );
  useEffect(() => {
    setCommitted(retained);
  }, [retained]);
  return retained;
}
