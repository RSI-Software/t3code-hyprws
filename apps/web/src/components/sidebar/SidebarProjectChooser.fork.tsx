// Fork-owned: the sidebar scope combobox as the window's multi-select project
// chooser (RSI-Software/t3code-hyprws#1352). `Sidebar.tsx` keeps upstream's
// combobox and carries marked hook lines pointing here: the chooser state, its
// value and change handler, the trigger's label and icon, and the row extras.
import type { ProjectFilter } from "@t3tools/client-runtime/state/project-filter";
import { CheckIcon, FocusIcon, FolderIcon, FoldersIcon, MinusIcon } from "lucide-react";
import { useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import {
  projectChooserState,
  projectFilterFromChooser,
  showOnlyProjectFilter,
  useProjectChooserHost,
  type ProjectChooserGroup,
  type ProjectChooserItem,
} from "../../projectChooser.fork";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function useSidebarProjectChooserFork<Group extends ProjectChooserGroup>(input: {
  readonly filter: ProjectFilter;
  readonly setFilter: (filter: ProjectFilter) => void;
  readonly projectGroups: ReadonlyArray<Group>;
  /** False where the header shows no chooser: no projects yet. */
  readonly enabled: boolean;
  readonly setMenuOpen: (open: boolean) => void;
}) {
  const { filter, setFilter, projectGroups, enabled, setMenuOpen } = input;
  const state = useMemo(() => projectChooserState(filter, projectGroups), [filter, projectGroups]);
  const selectedValues = useMemo(
    () => new Set(state.value.map((item) => item.value)),
    [state.value],
  );
  const unavailableValues = useMemo(
    () => new Set(state.items.filter((item) => item.unavailable).map((item) => item.value)),
    [state.items],
  );
  const onValueChange = useCallback(
    (items: ReadonlyArray<ProjectChooserItem>) =>
      setFilter(
        projectFilterFromChooser(
          filter,
          items.map((item) => item.value),
          projectGroups,
        ),
      ),
    [filter, projectGroups, setFilter],
  );
  const showOnly = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, group: Group) => {
      event.preventDefault();
      event.stopPropagation();
      setFilter(showOnlyProjectFilter(group));
      setMenuOpen(false);
    },
    [setFilter, setMenuOpen],
  );
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const openLatest = useRef(() => {});
  openLatest.current = () => {
    // The chooser sits in the sidebar header, so a hidden sidebar shows first.
    if (isMobile) setOpenMobile(true);
    else setOpen(true);
    setMenuOpen(true);
  };
  // Stable, so the registered host only changes with the filter and its label.
  const open = useCallback(() => openLatest.current(), []);
  const registered = useMemo(
    () => ({
      open,
      label: state.label,
      titleLabel: state.titleLabel,
      filter,
      setFilter,
      groups: projectGroups,
    }),
    [filter, open, projectGroups, setFilter, state.label, state.titleLabel],
  );
  useProjectChooserHost(registered, enabled);
  return { ...state, selectedValues, unavailableValues, onValueChange, showOnly };
}

/** The trigger's icon while no single project is selected: all, or several. */
export function ProjectChooserTriggerIconFork({ count }: { readonly count: number }) {
  return count > 1 ? <FoldersIcon className="size-4" /> : <FolderIcon className="size-4" />;
}

/** A row's selection mark; kept in layout when unselected so labels stay aligned. */
export function ProjectChooserRowMarkFork({
  selected,
  excluded = false,
}: {
  readonly selected: boolean;
  readonly excluded?: boolean;
}) {
  const Icon = excluded ? MinusIcon : CheckIcon;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", selected ? null : "invisible")} />;
}

/** Switching modes keeps the picks; their meaning changes explicitly, not via a modifier key. */
export function ProjectChooserModeFork({
  filter,
  setFilter,
}: {
  readonly filter: ProjectFilter;
  readonly setFilter: (filter: ProjectFilter) => void;
}) {
  const mode = filter.mode ?? "include";
  return (
    <div className="flex flex-col gap-2 px-2 pt-2 pb-1">
      <ToggleGroup
        aria-label="Project filter mode"
        value={[mode]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "include" || next === "exclude") setFilter({ ...filter, mode: next });
        }}
      >
        <Toggle value="include">Only selected</Toggle>
        <Toggle value="exclude">All except selected</Toggle>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">
        {mode === "exclude"
          ? "Select projects to hide. New projects stay visible."
          : "Select projects to show. No selection shows all."}
      </p>
    </div>
  );
}

/** Marks a selected entry no current project carries, e.g. while its server is offline. */
export function ProjectChooserUnavailableFork({ unavailable }: { readonly unavailable: boolean }) {
  if (!unavailable) return null;
  return <span className="ml-auto shrink-0 text-muted-foreground text-xs">Unavailable</span>;
}

/** A project row's Show only: the filter becomes this project alone. */
export function ProjectChooserShowOnlyButtonFork<Group extends ProjectChooserGroup>(props: {
  readonly project: Group;
  readonly onShowOnly: (event: ReactMouseEvent<HTMLButtonElement>, project: Group) => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      tabIndex={-1}
      aria-hidden="true"
      title={`Show only ${props.project.displayName}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => props.onShowOnly(event, props.project)}
    >
      <FocusIcon className="size-3.5" />
    </Button>
  );
}
