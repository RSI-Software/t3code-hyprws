import { FolderCogIcon } from "lucide-react";

import { resolveEnvModeLabel } from "./BranchToolbar.logic";
import { MenuRadioItem } from "./ui/menu";
import { SelectItem } from "./ui/select";

// Fork: the "New worktrunk" entries mounted inside upstream's workspace
// selector and menu through marked JSX hooks in BranchToolbar.tsx and
// BranchToolbarEnvModeSelector.tsx.
export function BranchToolbarWorktrunkMenuItem({ disabled }: { disabled: boolean }) {
  return (
    <MenuRadioItem disabled={disabled} value="worktrunk">
      <span className="flex min-w-0 items-center gap-1.5">
        <FolderCogIcon className="size-3" />
        <span className="min-w-0 truncate">{resolveEnvModeLabel("worktrunk")}</span>
      </span>
    </MenuRadioItem>
  );
}

export function BranchToolbarWorktrunkSelectItem() {
  return (
    <SelectItem value="worktrunk">
      <span className="inline-flex items-center gap-1.5">
        <FolderCogIcon className="size-3" />
        {resolveEnvModeLabel("worktrunk")}
      </span>
    </SelectItem>
  );
}
