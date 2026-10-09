import { Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

export function TerminalNewMenu({
  disabled,
  label,
  onNewTerminal,
}: {
  disabled: boolean;
  label: string;
  onNewTerminal: (plainShell?: boolean) => void;
}) {
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
        <MenuItem onClick={() => onNewTerminal(true)}>New plain shell</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
