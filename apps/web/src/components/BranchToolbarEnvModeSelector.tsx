import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { FolderCogIcon } from "lucide-react"; // fork-hook: worktrunk-hooks/env-mode-selector-cog-import
import { isWorktreeEnvMode } from "@t3tools/shared/threadEnvMode.fork"; // fork-hook: worktrunk-hooks/env-mode-selector-worktree-mode-import
import { memo, useMemo, type MouseEvent as ReactMouseEvent } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { BranchToolbarWorktrunkSelectItem } from "./BranchToolbarEnvModeSelector.fork"; // fork-hook: worktrunk-hooks/env-mode-selector-worktrunk-item-import
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeWorktrunk?: boolean; // fork-hook: worktrunk-hooks/env-mode-selector-worktrunk-prop-type
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  activeWorktrunk = false, // fork-hook: worktrunk-hooks/env-mode-selector-worktrunk-default
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(
    () => [
      {
        value: "local",
        label: resolveCurrentWorkspaceLabel(activeWorktreePath),
      },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      { value: "worktrunk", label: resolveEnvModeLabel("worktrunk") }, // fork-hook: worktrunk-hooks/env-mode-selector-worktrunk-option
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
    ],
    [activeWorktreePath, previousWorktreeLabel, showPreviousWorktree],
  );

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {/* fork-hook: worktrunk-hooks/env-mode-selector-locked-icon */}
        {activeWorktreePath ? (
          activeWorktrunk ? (
            <FolderCogIcon className="size-3" /> // fork-hook: worktrunk-hooks/locked-worktrunk-icon
          ) : (
            <FolderGitIcon className="size-3" /> // fork-hook: worktrunk-hooks/locked-worktree-icon
          )
        ) : effectiveEnvMode === "worktrunk" ? (
          <FolderCogIcon className="size-3" /> // fork-hook: worktrunk-hooks/new-worktrunk-icon
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        {/* fork-hook-end */}
        <ComposerContextLabel>
          {/* fork-hook: worktrunk-hooks/env-mode-selector-locked-label */}
          {
            forceNewWorktree
              ? resolveEnvModeLabel("worktree")
              : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, activeWorktrunk) // fork-hook: worktrunk-hooks/locked-worktrunk-label
          }
          {/* fork-hook-end */}
        </ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {/* fork-hook: worktrunk-hooks/env-mode-selector-locked-tooltip */}
          {
            forceNewWorktree
              ? "Each model starts in its own worktree."
              : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode, activeWorktrunk) // fork-hook: worktrunk-hooks/locked-worktrunk-tooltip
          }
          {/* fork-hook-end */}
        </TooltipPopup>
      </Tooltip>
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
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
            />
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : effectiveEnvMode === "worktrunk" ? ( // fork-hook: worktrunk-hooks/env-mode-selector-trigger-icon
            <FolderCogIcon // fork-hook: worktrunk-hooks/env-mode-selector-trigger-cog-icon
              className="size-3" // fork-hook: worktrunk-hooks/env-mode-selector-trigger-cog-size
            />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {isWorktreeEnvMode(effectiveEnvMode) // fork-hook: worktrunk-hooks/env-mode-selector-trigger-tooltip
            ? resolveEnvModeLabel(effectiveEnvMode) // fork-hook: worktrunk-hooks/env-mode-selector-trigger-tooltip-label
            : resolveCurrentWorkspaceLabel(activeWorktreePath)}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
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
          {/* fork-hook: worktrunk-hooks/env-mode-selector-worktrunk-item */}
          <BranchToolbarWorktrunkSelectItem />
          {/* fork-hook-end */}
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
