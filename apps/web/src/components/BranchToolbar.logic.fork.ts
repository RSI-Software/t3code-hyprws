import { ForkThreadEnvMode } from "@t3tools/contracts";

import { m, type MessageResolver } from "../i18n/messages";
import { resolveEnvModeLabel } from "./BranchToolbar.logic";

export const EnvModeFork = ForkThreadEnvMode;
export type EnvModeFork = typeof EnvModeFork.Type;

export function resolveEnvModeLabelFork(mode: EnvModeFork, resolve: MessageResolver = m): string {
  return mode === "worktrunk" ? "New worktrunk" : resolveEnvModeLabel(mode, resolve);
}

/** Fork: the workspace icon for the fork-only worktrunk shape. */
export { FolderCogIcon as WorktrunkWorkspaceIconFork } from "lucide-react";
