import { Folder, Globe2, Star, Trash2 } from "lucide-react";

import type { BrowserBookmarkScope } from "~/browserBookmarkStore";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

interface Props {
  scope: BrowserBookmarkScope | null;
  projectAvailable: boolean;
  onScopeChange: (scope: BrowserBookmarkScope) => void;
  onRemove: () => void;
}

export function PreviewBookmarkMenu({ scope, projectAvailable, onScopeChange, onRemove }: Props) {
  const label =
    scope === "project"
      ? "Edit project bookmark"
      : scope === "global"
        ? "Edit global bookmark"
        : "Bookmark this page";

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={label}
                  aria-pressed={scope !== null}
                />
              }
            />
          }
        >
          <Star className={cn(scope && "fill-current text-primary")} />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-52">
        <MenuGroupLabel>Save page to</MenuGroupLabel>
        <MenuRadioGroup
          value={scope ?? ""}
          onValueChange={(value) => {
            if (value === "project" || value === "global") onScopeChange(value);
          }}
        >
          <MenuRadioItem value="project" disabled={!projectAvailable}>
            <span className="flex items-center gap-2">
              <Folder className="size-4 text-muted-foreground" />
              Project bookmarks
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="global">
            <span className="flex items-center gap-2">
              <Globe2 className="size-4 text-muted-foreground" />
              Global bookmarks
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
        {scope ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onRemove}>
              <Trash2 />
              Remove bookmark
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
