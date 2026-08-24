import { Eye, EyeOff } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  getClientSettings,
  subscribeClientSettings,
  updateClientSettings,
} from "~/hooks/useSettings";
import { bindIgnoredFilesPreferenceFork, useShowIgnoredFiles } from "./ignoredFilesPreference.fork";

bindIgnoredFilesPreferenceFork({
  getSnapshot: () => getClientSettings().showIgnoredFiles === true,
  subscribe: subscribeClientSettings,
});

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
 * Fork-owned preference binding for the file browser: reads the show-ignored-files
 * client setting and hands the panel the updater for its toggle.
 */
export function useIgnoredFilesPreference() {
  const showIgnoredFiles = useShowIgnoredFiles();
  return { showIgnoredFiles, updateClientSettings };
}
