import { useRef, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "../lib/utils";

export function SidebarRenameInput(props: {
  readonly value: string;
  readonly ariaLabel: string;
  readonly onValueChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly className?: string | undefined;
}) {
  const completedRef = useRef(false);
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      completedRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      completedRef.current = true;
      props.onCancel();
    }
  };
  const stopPropagation = (event: MouseEvent<HTMLInputElement>) => event.stopPropagation();

  return (
    <input
      autoFocus
      value={props.value}
      aria-label={props.ariaLabel}
      onChange={(event) => props.onValueChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!completedRef.current) props.onCommit();
      }}
      onClick={stopPropagation}
      onDoubleClick={stopPropagation}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground",
        props.className,
      )}
    />
  );
}
