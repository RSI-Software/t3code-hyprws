import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ChevronDownIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { pullRequestProjectKey } from "../pullRequest/PullRequestListFilters";
import { Button } from "../ui/button";
import { ISSUE_CONTROL_LABEL } from "./GitHubIssueListControls";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

/**
 * Lays a project icon beside its label inside a radio item; `muted` greys rows outside the window.
 */
function ProjectRowLabel({
  muted,
  children,
}: {
  readonly muted: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", muted && "text-muted-foreground")}>
      {children}
    </span>
  );
}

export const ALL_PROJECTS_VALUE = "__all__";

function ProjectRow({
  project,
  muted,
}: {
  readonly project: EnvironmentProject;
  readonly muted: boolean;
}) {
  return (
    <MenuRadioItem value={pullRequestProjectKey(project)} closeOnClick>
      <ProjectRowLabel muted={muted}>
        <ProjectFavicon project={project} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{project.title}</span>
      </ProjectRowLabel>
    </MenuRadioItem>
  );
}

/**
 * Picks which project's issues the list shows. `value` is a `pullRequestProjectKey`, or
 * `ALL_PROJECTS_VALUE`.
 *
 * In a project window `windowProjectKey` names that window's own project, which leads the menu and
 * is the default. Everything below the separator is still selectable, just greyed, so looking
 * outside the window reads as deliberate rather than as the window having lost its scope.
 */
export function GitHubIssueProjectMenu({
  projects,
  value,
  windowProjectKey,
  onValueChange,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: string;
  readonly windowProjectKey: string | null;
  readonly onValueChange: (value: string) => void;
}) {
  const windowProject = projects.find(
    (project) => pullRequestProjectKey(project) === windowProjectKey,
  );
  const selected = projects.find((project) => pullRequestProjectKey(project) === value);
  const others = projects.filter((project) => project !== windowProject);
  const outside = windowProject !== undefined && value !== windowProjectKey;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            aria-label="Filter GitHub issues by project"
            className="min-w-0 max-w-44 justify-between"
          />
        }
      >
        <span className={cn("flex min-w-0 items-center gap-2", outside && "text-muted-foreground")}>
          {selected ? (
            <ProjectFavicon project={selected} className="size-4 shrink-0" />
          ) : (
            <LayersIcon aria-hidden className="size-4 shrink-0" />
          )}
          <span className={cn("min-w-0 truncate", ISSUE_CONTROL_LABEL)}>
            {selected?.title ?? "All projects"}
          </span>
        </span>
        <ChevronDownIcon aria-hidden className="-mr-px size-4 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-96 min-w-56 overflow-y-auto">
        <MenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== value) onValueChange(next);
          }}
        >
          {windowProject === undefined ? null : (
            <>
              <MenuGroupLabel>This window</MenuGroupLabel>
              <ProjectRow project={windowProject} muted={false} />
              <MenuSeparator />
              <MenuGroupLabel>Outside this window</MenuGroupLabel>
            </>
          )}
          <MenuRadioItem value={ALL_PROJECTS_VALUE} closeOnClick>
            <ProjectRowLabel muted={windowProject !== undefined}>
              <LayersIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate">All projects</span>
            </ProjectRowLabel>
          </MenuRadioItem>
          {others.map((project) => (
            <ProjectRow
              key={pullRequestProjectKey(project)}
              project={project}
              muted={windowProject !== undefined}
            />
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
