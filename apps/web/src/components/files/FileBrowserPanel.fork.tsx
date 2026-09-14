import type { GitStatusEntry } from "@pierre/trees";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { Eye, EyeOff } from "lucide-react";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export function ShowIgnoredFilesButton(props: { shown: boolean; onToggle: () => void }) {
  const action = props.shown ? "Hide ignored files" : "Show ignored files";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={action}
            aria-pressed={props.shown}
            data-pressed={props.shown || undefined}
            onClick={props.onToggle}
          />
        }
      >
        {props.shown ? <Eye /> : <EyeOff />}
      </TooltipTrigger>
      <TooltipPopup>{action}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Fork-owned workspace file listing for the file browser: folds the
 * show-ignored-files preference into the entries query and derives the
 * ignored-entry git status overlay from the same listing, so the shared
 * panel carries one hook call instead of the woven policy.
 */
export function useIgnoredWorkspaceFileListing(environmentId: EnvironmentId, cwd: string) {
  const showIgnoredFiles = useClientSettings((settings) => settings.showIgnoredFiles);
  const updateClientSettings = useUpdateClientSettings();
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd, undefined, showIgnoredFiles);
  const entries = entriesQuery.data?.entries ?? [];
  const ignoredGitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(
    () =>
      entries.flatMap((entry) =>
        entry.ignored ? [{ path: treePath(entry), status: "ignored" as const }] : [],
      ),
    [entries],
  );
  return { entriesQuery, showIgnoredFiles, updateClientSettings, ignoredGitStatus };
}
