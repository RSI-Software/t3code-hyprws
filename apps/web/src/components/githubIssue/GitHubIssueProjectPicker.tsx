import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { pullRequestProjectKey } from "../pullRequest/PullRequestListFilters";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const ALL_PROJECTS_VALUE = "__all__";

export function GitHubIssueProjectPicker({
  projects,
  selected,
  onChange,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selected: EnvironmentProject | undefined;
  readonly onChange: (
    projectId: ProjectId | undefined,
    environmentId: EnvironmentId | undefined,
  ) => void;
}) {
  return (
    <Select
      value={selected ? pullRequestProjectKey(selected) : ALL_PROJECTS_VALUE}
      onValueChange={(value: string | null) => {
        const project = projects.find((candidate) => pullRequestProjectKey(candidate) === value);
        onChange(project?.id, project?.environmentId);
      }}
    >
      <SelectTrigger aria-label="Filter GitHub issues by project" className="min-w-32 sm:w-auto">
        <SelectValue>{selected?.title ?? "All projects"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
        {projects.map((project) => (
          <SelectItem key={pullRequestProjectKey(project)} value={pullRequestProjectKey(project)}>
            {project.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
