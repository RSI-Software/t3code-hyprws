import type { KeybindingCommand } from "@t3tools/contracts";
import { msg } from "gt-react";

export const forkKeybindingLabels: Partial<Record<KeybindingCommand, string>> = {
  "terminal.focus": msg("Terminal: Focus"),
  "window.new": msg("Window: New"),
  "window.openProject": msg("Window: Open Project"),
  "projectFilter.choose": msg("Project Filter: Choose"),
  "chat.focusComposer": msg("Chat: Focus Composer"),
};
