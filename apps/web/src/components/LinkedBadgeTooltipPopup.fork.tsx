import type { ReactNode } from "react";

import { TooltipPopup } from "./ui/tooltip";

/** The hover list a thread's linked-item badge (issues, artifacts) shows, scrolling when long. */
export function LinkedBadgeTooltipPopupFork({ children }: { readonly children: ReactNode }) {
  return (
    <TooltipPopup
      side="top"
      sideOffset={0}
      variant="glass"
      className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
    >
      <div className="-mx-1 max-h-[calc(var(--available-height)-0.5rem-2px)] overflow-y-auto overscroll-contain px-1">
        {children}
      </div>
    </TooltipPopup>
  );
}
