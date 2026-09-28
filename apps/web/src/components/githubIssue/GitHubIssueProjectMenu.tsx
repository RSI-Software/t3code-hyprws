import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ChevronDownIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { pullRequestProjectKey } from "../pullRequest/PullRequestListFilters";
import { Button } from "../ui/button";
import { ISSUE_CONTROL_LABEL } from "./GitHubIssueListControls";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";

/** Lays a project icon beside its label inside a radio item. */
function ProjectRowLabel({ children }: { readonly children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-2">{children}</span>;
}

export const ALL_PROJECTS_VALUE = "__all__";

function ProjectRow({ project }: { readonly project: EnvironmentProject }) {
  return (
    <MenuRadioItem value={pullRequestProjectKey(project)} closeOnClick>
      <ProjectRowLabel>
        <ProjectFavicon project={project} className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{project.title}</span>
      </ProjectRowLabel>
    </MenuRadioItem>
  );
}

/**
 * Picks which project's issues the list shows. `value` is a `pullRequestProjectKey`, or
 * `ALL_PROJECTS_VALUE`, which lists every project `projects` holds.
 */
export function GitHubIssueProjectMenu({
  projects,
  value,
  onValueChange,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) {
  const selected = projects.find((project) => pullRequestProjectKey(project) === value);

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
        <span className="flex min-w-0 items-center gap-2">
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
          <MenuRadioItem value={ALL_PROJECTS_VALUE} closeOnClick>
            <ProjectRowLabel>
              <LayersIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate">All projects</span>
            </ProjectRowLabel>
          </MenuRadioItem>
          {projects.map((project) => (
            <ProjectRow key={pullRequestProjectKey(project)} project={project} />
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
