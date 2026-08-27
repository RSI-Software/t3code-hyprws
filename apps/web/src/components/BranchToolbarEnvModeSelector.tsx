import {
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  HistoryIcon,
  ToggleLeftIcon,
  ToggleRightIcon,
} from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";
export const WORKTRUNK_HOOKS_SELECT_VALUE = "worktrunk-hooks";
export const WORKTRUNK_HOOKS_LABEL = "Run Worktrunk hooks";

/**
 * The project's resolved Worktrunk hooks state for the workspace picker.
 * Toggling writes the project override, the same value Project settings edits.
 */
export interface WorktrunkHooksControl {
  readonly enabled: boolean;
  readonly onToggle: () => void;
}

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
  worktrunkHooks?: WorktrunkHooksControl | null;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
  worktrunkHooks,
}: BranchToolbarEnvModeSelectorProps) {
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  // Only a new worktree runs hooks, so the item appears once that mode is
  // picked. Like "previous worktree", selecting it acts without changing the
  // picker's value.
  const showWorktrunkHooks = effectiveEnvMode === "worktree" && Boolean(worktrunkHooks);
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
      ...(showWorktrunkHooks
        ? [{ value: WORKTRUNK_HOOKS_SELECT_VALUE, label: WORKTRUNK_HOOKS_LABEL }]
        : []),
    ],
    [activeWorktreePath, previousWorktreeLabel, showPreviousWorktree, showWorktrunkHooks],
  );

  if (envLocked) {
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        if (value === WORKTRUNK_HOOKS_SELECT_VALUE) {
          worktrunkHooks?.onToggle();
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 shrink font-medium"
        aria-label="Workspace"
        data-composer-context-control
      >
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <span className="inline-flex items-center gap-1.5">
                <HistoryIcon className="size-3" />
                {previousWorktreeLabel}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
        {showWorktrunkHooks && worktrunkHooks ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectGroupLabel>Worktrunk</SelectGroupLabel>
              <SelectItem
                value={WORKTRUNK_HOOKS_SELECT_VALUE}
                aria-label={`${WORKTRUNK_HOOKS_LABEL}: ${worktrunkHooks.enabled ? "on" : "off"}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {worktrunkHooks.enabled ? (
                    <ToggleRightIcon className="size-3" />
                  ) : (
                    <ToggleLeftIcon className="size-3 text-muted-foreground" />
                  )}
                  {WORKTRUNK_HOOKS_LABEL}
                  <span className="text-muted-foreground">
                    {worktrunkHooks.enabled ? "on" : "off"}
                  </span>
                </span>
              </SelectItem>
            </SelectGroup>
          </>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
