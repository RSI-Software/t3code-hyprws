// Fork-owned: the Issues and Pull requests scope label for the window's project
// chooser (RSI-Software/t3code-hyprws#1352). It names the window's project
// filter and opens the sidebar's chooser.
import { FolderIcon } from "lucide-react";

import { openProjectChooser, useProjectChooserLabel } from "../projectChooser.fork";
import { Button } from "./ui/button";

export function ProjectChooserScopeLabelFork() {
  const label = useProjectChooserLabel();
  if (label === null) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Choose window projects (${label})`}
      onClick={() => openProjectChooser()}
    >
      <FolderIcon />
      <span className="shrink-0">Window:</span>
      <span className="max-w-32 truncate">{label.replace(/^Projects: /, "")}</span>
    </Button>
  );
}
