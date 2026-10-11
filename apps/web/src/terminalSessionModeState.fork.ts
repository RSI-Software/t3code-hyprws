import type { TerminalSessionMode } from "@t3tools/contracts";

/**
 * Fork (zmux-estate): the per-terminal launch-mode map with `terminalId` set
 * to `mode`, or cleared when no mode is given. Store actions spread it.
 */
export const withTerminalSessionModeFork = (
  state: { readonly sessionModeByTerminalId?: Readonly<Record<string, TerminalSessionMode>> },
  terminalId: string,
  mode?: TerminalSessionMode,
): { sessionModeByTerminalId: Record<string, TerminalSessionMode> } => {
  const rest = Object.fromEntries(
    Object.entries(state.sessionModeByTerminalId ?? {}).filter(([id]) => id !== terminalId),
  );
  return { sessionModeByTerminalId: mode ? { ...rest, [terminalId]: mode } : rest };
};

type PersistedThreadModesFork = {
  readonly plainShellByTerminalId?: Readonly<Record<string, unknown>>;
  readonly sessionModeByTerminalId?: Readonly<Record<string, TerminalSessionMode>>;
};

/**
 * Fork (zmux-estate): rehydrated store state with the retired
 * `plainShellByTerminalId` flags folded into `sessionModeByTerminalId` as
 * `"shell"`. Newer explicit modes win. Drop once no stored state predates it.
 */
export const foldLegacyPlainShellFork = (persisted: unknown): object => {
  if (!persisted || typeof persisted !== "object") return {};
  const { terminalUiStateByThreadKey } = persisted as {
    terminalUiStateByThreadKey?: Record<string, PersistedThreadModesFork>;
  };
  if (!terminalUiStateByThreadKey) return persisted;
  const fold = ({ plainShellByTerminalId: legacy, ...state }: PersistedThreadModesFork) =>
    legacy
      ? {
          ...state,
          sessionModeByTerminalId: {
            ...Object.fromEntries(
              Object.keys(legacy)
                .filter((id) => legacy[id] === true)
                .map((id) => [id, "shell" as const]),
            ),
            ...state.sessionModeByTerminalId,
          },
        }
      : state;
  return {
    ...persisted,
    terminalUiStateByThreadKey: Object.fromEntries(
      Object.entries(terminalUiStateByThreadKey).map(([key, state]) => [key, fold(state)]),
    ),
  };
};
