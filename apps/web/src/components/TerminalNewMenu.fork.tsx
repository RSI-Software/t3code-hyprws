import type { EnvironmentId, ScopedThreadRef, TerminalSessionMode } from "@t3tools/contracts";
import { Plus } from "lucide-react";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

type NewTerminal = (sessionMode?: TerminalSessionMode) => void;

const ALTERNATIVE_LABELS = { shell: "New plain shell", zmux: "New zmux shell" } as const;

/**
 * Upstream wires add-terminal callbacks straight to `onClick`, so a click
 * event can arrive where a mode is expected. Only a literal mode is a choice;
 * anything else opens the default.
 */
export const terminalSessionModeChoiceFork = (value: unknown): TerminalSessionMode | undefined =>
  value === "shell" || value === "zmux" ? value : undefined;

/** The launch mode a terminal chose at creation, when it overrode the default. */
export const useTerminalSessionModeFork = (threadRef: ScopedThreadRef, terminalId: string) =>
  useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef)
        .sessionModeByTerminalId?.[terminalId],
  );

/** The mode a terminal can opt into instead of the environment's default. */
function useAlternativeMode(environmentId: EnvironmentId): TerminalSessionMode {
  const defaultMode = useEnvironmentSettings(environmentId, (s) => s.terminalSessionMode);
  return defaultMode === "zmux" ? "shell" : "zmux";
}

export function TerminalNewMenu({
  environmentId,
  disabled,
  label,
  onNewTerminal,
}: {
  environmentId: EnvironmentId;
  disabled: boolean;
  label: string;
  onNewTerminal: NewTerminal;
}) {
  const alternative = useAlternativeMode(environmentId);
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon-xs" />}
        disabled={disabled}
        aria-label={label}
      >
        <Plus className="size-3.25" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => onNewTerminal()}>{label}</MenuItem>
        <MenuItem onClick={() => onNewTerminal(alternative)}>
          {ALTERNATIVE_LABELS[alternative]}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function TerminalAlternativeModeButton({
  environmentId,
  disabled,
  onNewTerminal,
}: {
  environmentId: EnvironmentId;
  disabled: boolean;
  onNewTerminal: NewTerminal;
}) {
  const alternative = useAlternativeMode(environmentId);
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={disabled}
      onClick={() => onNewTerminal(alternative)}
    >
      {ALTERNATIVE_LABELS[alternative]}
    </Button>
  );
}
