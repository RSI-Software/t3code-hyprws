import { useAtomValue } from "@effect/atom-react";
import {
  environmentGitHubIssueKey,
  type EnvironmentGitHubIssueListEntry,
} from "@t3tools/client-runtime/state/github-issues";
import type { GitHubIssueListState, ScopedProjectRef } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  EnvironmentGitHubIssueDetailContent,
  GitHubIssueDetailContent,
} from "../components/githubIssue/GitHubIssueDetailPanel";
import { GitHubIssueEmptyState } from "../components/githubIssue/GitHubIssueEmptyState";
import { resolveGitHubIssueQueryTargets } from "../components/githubIssue/GitHubIssueList.logic";
import { GitHubIssueListGhosts } from "../components/githubIssue/GitHubIssueGhosts";
import { GitHubIssueRow } from "../components/githubIssue/GitHubIssueRow";
import { GitHubIssueProjectPicker } from "../components/githubIssue/GitHubIssueProjectPicker";
import {
  selectedGitHubIssueRef,
  validateGitHubIssueSearch,
  type IssuesSearch,
} from "../components/githubIssue/githubIssueRouteSearch";
import { WindowProjectScopeToggle } from "../components/WindowProjectScopeToggle";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { githubIssueEnvironment, useGitHubIssueList } from "../state/githubIssues";
import { useDebouncedValue } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import {
  allEnvironmentShellsBootstrappedAtom,
  environmentShellBootstrappedAtom,
} from "../state/shell";
import { useWindowProjectListScope } from "../windowProjectScope";

const STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: GitHubIssueListState; label: string }>;

export type IssuesSearchUpdater = (update: (previous: IssuesSearch) => IssuesSearch) => void;
type IssuesSearchPatch = {
  [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined;
};

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: validateGitHubIssueSearch,
  component: GitHubIssuesRoute,
});

function GitHubIssuesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <GitHubIssuesPage
      forcedProjectRef={null}
      search={search}
      onNavigate={(update) => void navigate({ search: update, replace: true })}
    />
  );
}

export function GitHubIssuesPage({
  forcedProjectRef,
  search,
  onNavigate,
}: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly search: IssuesSearch;
  readonly onNavigate: IssuesSearchUpdater;
}) {
  const { environments } = useEnvironments();
  const capableEnvironments = useMemo(
    () =>
      environments
        .filter(
          (environment) => environment.serverConfig?.environment.capabilities.githubIssues === true,
        )
        .toSorted((left, right) => left.environmentId.localeCompare(right.environmentId)),
    [environments],
  );
  const { listScope, onScopeChange } = useWindowProjectListScope(forcedProjectRef, search.scope);
  const capabilityKnown =
    listScope.kind === "project"
      ? environments.some(
          (environment) =>
            environment.environmentId === listScope.projectRef.environmentId &&
            environment.serverConfig !== null,
        )
      : environments.some((environment) => environment.serverConfig !== null);
  const supported = capableEnvironments.some((environment) =>
    listScope.kind === "project"
      ? environment.environmentId === listScope.projectRef.environmentId
      : true,
  );

  const allProjects = useProjects();
  const projectsKnown = useAtomValue(
    listScope.kind === "project"
      ? environmentShellBootstrappedAtom(listScope.projectRef.environmentId)
      : allEnvironmentShellsBootstrappedAtom,
  );
  const scopedEnvironmentId =
    listScope.kind === "project" ? listScope.projectRef.environmentId : null;
  const allowedEnvironmentIds = useMemo(
    () =>
      new Set(
        scopedEnvironmentId === null
          ? capableEnvironments.map((environment) => environment.environmentId)
          : [scopedEnvironmentId],
      ),
    [capableEnvironments, scopedEnvironmentId],
  );
  const githubProjects = useMemo(
    () =>
      allProjects
        .filter(
          (project) =>
            allowedEnvironmentIds.has(project.environmentId) &&
            project.repositoryIdentity?.provider === "github",
        )
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, allowedEnvironmentIds],
  );
  const scopedProject =
    forcedProjectRef !== null
      ? listScope.kind === "project"
        ? githubProjects.find(
            (project) =>
              project.id === forcedProjectRef.projectId &&
              project.environmentId === forcedProjectRef.environmentId,
          )
        : undefined
      : githubProjects.find(
          (project) =>
            project.id === search.projectId && project.environmentId === search.environmentId,
        );
  const scopedProjectId =
    forcedProjectRef !== null && listScope.kind === "project"
      ? forcedProjectRef.projectId
      : !projectsKnown || scopedProject !== undefined
        ? search.projectId
        : undefined;
  const queryEnvironmentIds = useMemo(
    () =>
      listScope.kind === "all" && scopedProject !== undefined
        ? [scopedProject.environmentId]
        : capableEnvironments.map((environment) => environment.environmentId),
    [capableEnvironments, listScope.kind, scopedProject],
  );
  const typedQuery = search.q?.trim() ?? "";
  const sentQuery = useDebouncedValue(typedQuery, 250);
  const targets = useMemo(
    () =>
      supported
        ? resolveGitHubIssueQueryTargets({
            capableEnvironmentIds: queryEnvironmentIds,
            listScope,
            state: search.state,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(sentQuery ? { query: sentQuery } : {}),
          })
        : [],
    [listScope, queryEnvironmentIds, scopedProjectId, search.state, sentQuery, supported],
  );
  const listQuery = useGitHubIssueList(targets);
  const selectedRef = selectedGitHubIssueRef(search);
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === selectedRef?.environmentId,
  );
  const selectedEnvironmentUnavailable = selectedRef !== null && selectedEnvironment === undefined;
  const selectedCapabilityKnown = selectedEnvironment?.serverConfig !== null;
  const selectedSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.githubIssues === true;
  const detailQuery = useEnvironmentQuery(
    selectedRef && selectedSupported
      ? githubIssueEnvironment.detail({
          environmentId: selectedRef.environmentId,
          input: {
            projectId: selectedRef.projectId,
            repository: selectedRef.repository,
            number: selectedRef.number,
          },
        })
      : null,
  );

  const updateSearch = useCallback(
    (patch: IssuesSearchPatch) =>
      onNavigate((previous) => {
        const next = { ...previous, ...patch };
        return {
          state: next.state ?? previous.state,
          ...(next.q ? { q: next.q } : {}),
          ...(forcedProjectRef === null && next.projectId ? { projectId: next.projectId } : {}),
          ...(forcedProjectRef === null && next.environmentId
            ? { environmentId: next.environmentId }
            : {}),
          ...(next.selectedEnvironmentId
            ? { selectedEnvironmentId: next.selectedEnvironmentId }
            : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.repository ? { repository: next.repository } : {}),
          ...(next.number ? { number: next.number } : {}),
          ...(next.scope === "all" ? { scope: next.scope } : {}),
        };
      }),
    [forcedProjectRef, onNavigate],
  );
  const clearSelection = {
    selectedEnvironmentId: undefined,
    selectedProjectId: undefined,
    repository: undefined,
    number: undefined,
  };
  const updateFilters = (patch: IssuesSearchPatch) => updateSearch({ ...patch, ...clearSelection });
  const selectIssue = useCallback(
    (issue: EnvironmentGitHubIssueListEntry) =>
      updateSearch({
        selectedEnvironmentId: issue.environmentId,
        selectedProjectId: issue.projectId,
        repository: issue.repository,
        number: issue.number,
      }),
    [updateSearch],
  );

  const stateLabel = STATE_OPTIONS.find((option) => option.value === search.state)?.label ?? "Open";
  const entries = listQuery.data?.entries ?? [];
  const body = !capabilityKnown ? (
    <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
      <Spinner className="size-4" /> Connecting to the environment...
    </div>
  ) : !supported ? (
    <GitHubIssueEmptyState
      title="GitHub issues unavailable"
      description="Update a connected T3 Code server to browse GitHub issues."
    />
  ) : projectsKnown && githubProjects.length === 0 ? (
    <GitHubIssueEmptyState
      title="No GitHub projects"
      description="Add a project backed by a GitHub repository and its issues will appear here."
    />
  ) : listQuery.isPending && listQuery.data === null ? (
    <GitHubIssueListGhosts />
  ) : listQuery.data?.environmentErrors.length && entries.length === 0 ? (
    <GitHubIssueEmptyState
      title="Could not load issues"
      description={
        listQuery.data.environmentErrors[0]?.message ?? "The environment did not answer."
      }
      action={<Button onClick={listQuery.refresh}>Try again</Button>}
    />
  ) : entries.length === 0 && (listQuery.data?.errors.length ?? 0) > 0 ? (
    <GitHubIssueEmptyState
      title="Could not load issues"
      description={listQuery.data?.errors[0]?.message ?? "GitHub did not answer."}
      action={<Button onClick={listQuery.refresh}>Try again</Button>}
    />
  ) : entries.length === 0 ? (
    <GitHubIssueEmptyState
      title="No issues"
      description={search.q ? "Nothing matched this search." : "No issues matched these filters."}
    />
  ) : (
    <div className="divide-y divide-border/60">
      {/* Rows are not virtualized: each environment/project query is capped at 50, and rows use content-visibility:auto. */}
      {entries.map((issue) => (
        <GitHubIssueRow
          key={environmentGitHubIssueKey(issue)}
          issue={issue}
          selected={
            selectedRef?.environmentId === issue.environmentId &&
            selectedRef.projectId === issue.projectId &&
            selectedRef.repository === issue.repository &&
            selectedRef.number === issue.number
          }
          showProject={scopedProjectId === undefined}
          onSelect={selectIssue}
        />
      ))}
    </div>
  );

  const detail = !selectedRef ? (
    <GitHubIssueDetailContent
      environmentId={null}
      detail={null}
      error={null}
      loading={false}
      onRetry={detailQuery.refresh}
    />
  ) : selectedEnvironmentUnavailable ? (
    <GitHubIssueEmptyState
      title="GitHub issues unavailable"
      description="This issue's environment is no longer available."
    />
  ) : !selectedCapabilityKnown ? (
    <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
      <Spinner className="size-4" /> Connecting to the environment...
    </div>
  ) : !selectedSupported ? (
    <GitHubIssueEmptyState
      title="GitHub issues unavailable"
      description="This issue's environment does not support GitHub Issues."
    />
  ) : (
    <EnvironmentGitHubIssueDetailContent
      environmentId={selectedRef.environmentId}
      detail={detailQuery.data}
      error={detailQuery.error}
      loading={detailQuery.isPending}
      onRetry={detailQuery.refresh}
    />
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="GitHub issues breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">GitHub Issues</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh GitHub issues"
            onClick={() => {
              listQuery.refresh();
              detailQuery.refresh();
            }}
          >
            <RefreshCwIcon className={cn("size-4", listQuery.isPending && "animate-spin")} />
          </Button>
        </WorkspacePageHeader>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(20rem,0.9fr)_minmax(24rem,1.1fr)]">
          <section className="flex min-h-0 min-w-0 flex-col border-r border-border">
            <div className="grid gap-2 border-b border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <InputGroup className="min-w-0">
                <InputGroupAddon>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search GitHub issues"
                  placeholder="Search issues"
                  value={search.q ?? ""}
                  onChange={(event) => updateFilters({ q: event.currentTarget.value || undefined })}
                />
              </InputGroup>
              <Select
                value={search.state}
                onValueChange={(value: string | null) => {
                  const next = STATE_OPTIONS.find((option) => option.value === value);
                  if (next) updateFilters({ state: next.value });
                }}
              >
                <SelectTrigger
                  aria-label="Filter GitHub issues by state"
                  className="min-w-28 sm:w-auto"
                >
                  <SelectValue>{stateLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {STATE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {forcedProjectRef === null ? (
                <GitHubIssueProjectPicker
                  projects={githubProjects}
                  selected={scopedProject}
                  onChange={(projectId, environmentId) =>
                    updateFilters({ projectId, environmentId })
                  }
                />
              ) : (
                <WindowProjectScopeToggle
                  forcedProjectRef={forcedProjectRef}
                  listScope={listScope}
                  onNavigate={(scope) =>
                    onScopeChange(scope, (scopePatch) => updateFilters(scopePatch))
                  }
                />
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {listQuery.data?.errors.map((error) => (
                <div
                  key={`${error.environmentId}:${error.projectId}`}
                  className="border-b border-warning/25 bg-warning-surface px-4 py-2 text-warning-foreground text-xs"
                >
                  {error.projectTitle}: {error.message}
                </div>
              ))}
              {listQuery.data?.environmentErrors.map((error) => (
                <div
                  key={error.environmentId}
                  className="border-b border-warning/25 bg-warning-surface px-4 py-2 text-warning-foreground text-xs"
                >
                  {error.message}
                </div>
              ))}
              {listQuery.data?.truncated ? (
                <div className="border-b border-border/60 px-4 py-2 text-muted-foreground text-xs">
                  Showing the newest 50 issues. Narrow the list with search or filters.
                </div>
              ) : null}
              {body}
            </div>
          </section>
          <section className="hidden min-h-0 min-w-0 overflow-y-auto md:block">{detail}</section>
        </div>
      </div>

      {selectedRef && selectedSupported ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background pb-safe md:hidden">
          <div className="sticky top-0 z-10 flex min-h-12 items-center border-b border-border bg-background/95 px-3 pt-safe backdrop-blur">
            <Button variant="ghost" size="sm" onClick={() => updateSearch(clearSelection)}>
              Back to issues
            </Button>
          </div>
          {detail}
        </div>
      ) : null}
    </SidebarInset>
  );
}
