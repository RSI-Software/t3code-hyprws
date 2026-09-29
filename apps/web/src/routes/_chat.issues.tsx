import { useAtomValue } from "@effect/atom-react";
import {
  environmentGitHubIssueKey,
  type EnvironmentGitHubIssueListEntry,
} from "@t3tools/client-runtime/state/github-issues";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LayersIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { EnvironmentGitHubIssueDetailContent } from "../components/githubIssue/GitHubIssueDetailPanel";
import { GitHubIssueEmptyState } from "../components/githubIssue/GitHubIssueEmptyState";
import { resolveGitHubIssueQueryTargets } from "../components/githubIssue/GitHubIssueList.logic";
import {
  GitHubIssueFilterAdd,
  GitHubIssueFilterBar,
} from "../components/githubIssue/GitHubIssueFilterBar";
import {
  GitHubIssueOrderMenu,
  GitHubIssueSearchField,
} from "../components/githubIssue/GitHubIssueListControls";
import {
  applyGitHubIssueListView,
  DEFAULT_GITHUB_ISSUE_ORDER,
  gitHubIssueFacets,
  gitHubIssueNarrowingIsEmpty,
  NO_GITHUB_ISSUE_NARROWING,
  toggleGitHubIssueNarrowing,
  type GitHubIssueFilterField,
  type GitHubIssueListNarrowing,
  type GitHubIssueOrder,
} from "../components/githubIssue/GitHubIssueListView.logic";
import { GitHubIssueListGhosts } from "../components/githubIssue/GitHubIssueGhosts";
import { GitHubIssueRow } from "../components/githubIssue/GitHubIssueRow";
import { useGitHubIssueKeyboard } from "../components/githubIssue/useGitHubIssueKeyboard";
import {
  ALL_PROJECTS_VALUE,
  GitHubIssueProjectMenu,
} from "../components/githubIssue/GitHubIssueProjectMenu";
import { GitHubIssueStateToggle } from "../components/githubIssue/GitHubIssueStateToggle";
import { GITHUB_ISSUE_STATE_PRESENTATION } from "../components/githubIssue/githubIssuePresentation";
import { pullRequestProjectKey } from "../components/pullRequest/PullRequestListFilters";
import {
  selectedGitHubIssueRef,
  validateGitHubIssueSearch,
  type IssuesSearch,
} from "../components/githubIssue/githubIssueRouteSearch";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { ProjectChooserScopeLabelFork } from "../components/ProjectChooserScopeLabel.fork"; // fork-hook: workspaces/chooser-scope-label
import { RightPanelTabs } from "../components/RightPanelTabs";
import { githubIssueSurface } from "../rightPanelStore.fork";
import { Button } from "../components/ui/button";
import { RefreshIcon } from "../components/ui/refresh-icon";
import { Separator } from "../components/ui/separator";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { isElectron } from "../env";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { githubIssueEnvironment, useGitHubIssueList } from "../state/githubIssues";
import { useDebouncedValue } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { allEnvironmentShellsBootstrappedAtom } from "../state/shell";
import { useWindowProjectKeys, windowListProjects } from "../windowProjectFilter.fork";

export type IssuesSearchUpdater = (update: (previous: IssuesSearch) => IssuesSearch) => void;
type IssuesSearchPatch = {
  [Key in keyof IssuesSearch]?: IssuesSearch[Key] | undefined;
};

const NO_ENTRIES: ReadonlyArray<EnvironmentGitHubIssueListEntry> = [];
// The inline panel shows one issue and none of the tools that would fill these.
const EMPTY_PREVIEW_SESSIONS = {};
const EMPTY_PREVIEW_DESKTOP_STATE = {};
const EMPTY_TERMINAL_LABELS = new Map<string, string>();
const EMPTY_PENDING_SURFACES = new Set<string>();

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: validateGitHubIssueSearch,
  component: GitHubIssuesRoute,
});

function GitHubIssuesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <GitHubIssuesPage
      search={search}
      onNavigate={(update) => void navigate({ search: update, replace: true })}
    />
  );
}

/** A thread's issues panel: it opens on the thread's project and can widen to the window's. */
export function ProjectGitHubIssuesPanel({
  projectRef,
  onSelectIssue,
}: {
  readonly projectRef: ScopedProjectRef;
  readonly onSelectIssue: (issue: EnvironmentGitHubIssueListEntry) => void;
}) {
  const [search, setSearch] = useState<IssuesSearch>({
    state: "open",
    projectId: projectRef.projectId,
    environmentId: projectRef.environmentId,
  });
  return (
    <GitHubIssuesPage
      search={search}
      onNavigate={(update) => setSearch((previous) => update(previous))}
      variant="panel"
      onSelectIssue={onSelectIssue}
    />
  );
}

/** The issue list. With no project picked it lists every project this window's filter shows. */
export function GitHubIssuesPage({
  search,
  onNavigate,
  variant = "page",
  onSelectIssue,
}: {
  readonly search: IssuesSearch;
  readonly onNavigate: IssuesSearchUpdater;
  readonly variant?: "page" | "panel";
  readonly onSelectIssue?: (issue: EnvironmentGitHubIssueListEntry) => void;
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
  const capabilityKnown = environments.some((environment) => environment.serverConfig !== null);
  const supported = capableEnvironments.length > 0;

  const allProjects = useProjects();
  const windowProjectKeys = useWindowProjectKeys();
  const projectsKnown = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  const capableEnvironmentIds = useMemo(
    () => new Set(capableEnvironments.map((environment) => environment.environmentId)),
    [capableEnvironments],
  );
  const githubProjects = useMemo(
    () =>
      // A linked project outside the window's filter is still an explicit request.
      windowListProjects(allProjects, windowProjectKeys, {
        projectId: search.projectId,
        environmentId: search.environmentId,
      })
        .filter(
          (project) =>
            capableEnvironmentIds.has(project.environmentId) &&
            project.repositoryIdentity?.provider === "github",
        )
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, capableEnvironmentIds, search.environmentId, search.projectId, windowProjectKeys],
  );
  const scopedProject = githubProjects.find(
    (project) => project.id === search.projectId && project.environmentId === search.environmentId,
  );
  // Kept while projects load, so a linked project is not dropped before it can be named.
  const scopedProjectId =
    !projectsKnown || scopedProject !== undefined ? search.projectId : undefined;
  const typedQuery = search.q?.trim() ?? "";
  const sentQuery = useDebouncedValue(typedQuery, 250);
  const targets = useMemo(
    () =>
      supported
        ? resolveGitHubIssueQueryTargets({
            capableEnvironmentIds: capableEnvironments.map(
              (environment) => environment.environmentId,
            ),
            windowProjects: windowProjectKeys === null ? null : githubProjects,
            state: search.state,
            ...(scopedProjectId
              ? {
                  scopedProject: {
                    projectId: scopedProjectId,
                    environmentId: scopedProject?.environmentId ?? search.environmentId,
                  },
                }
              : {}),
            ...(sentQuery ? { query: sentQuery } : {}),
          })
        : [],
    [
      capableEnvironments,
      githubProjects,
      scopedProject?.environmentId,
      scopedProjectId,
      search.environmentId,
      search.state,
      sentQuery,
      supported,
      windowProjectKeys,
    ],
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
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.environmentId ? { environmentId: next.environmentId } : {}),
          ...(next.selectedEnvironmentId
            ? { selectedEnvironmentId: next.selectedEnvironmentId }
            : {}),
          ...(next.selectedProjectId ? { selectedProjectId: next.selectedProjectId } : {}),
          ...(next.repository ? { repository: next.repository } : {}),
          ...(next.number ? { number: next.number } : {}),
        };
      }),
    [onNavigate],
  );
  const clearSelection = {
    selectedEnvironmentId: undefined,
    selectedProjectId: undefined,
    repository: undefined,
    number: undefined,
  };
  const updateFilters = (patch: IssuesSearchPatch) => updateSearch({ ...patch, ...clearSelection });
  const closeDetail = () => updateSearch(clearSelection);
  const isMobile = useIsMobile();
  const searchRef = useRef<HTMLDivElement | null>(null);
  const onListKeyDown = useGitHubIssueKeyboard({
    page: variant === "page",
    searchRef,
    openIssueUrl: selectedRef === null ? null : (detailQuery.data?.url ?? null),
    onCloseIssue: selectedRef === null ? null : closeDetail,
  });
  const projectMenuValue = scopedProject
    ? pullRequestProjectKey(scopedProject)
    : ALL_PROJECTS_VALUE;
  const selectProject = (next: string) => {
    const project = githubProjects.find((candidate) => pullRequestProjectKey(candidate) === next);
    updateFilters({ projectId: project?.id, environmentId: project?.environmentId });
  };
  const selectIssue = useCallback(
    (issue: EnvironmentGitHubIssueListEntry) => {
      if (onSelectIssue) {
        onSelectIssue(issue);
        return;
      }
      updateSearch({
        selectedEnvironmentId: issue.environmentId,
        selectedProjectId: issue.projectId,
        repository: issue.repository,
        number: issue.number,
      });
    },
    [onSelectIssue, updateSearch],
  );

  // Order and narrowing sit on the fetched list rather than the request, so they stay out of the
  // route search and reset with the page.
  const [order, setOrder] = useState<GitHubIssueOrder>(DEFAULT_GITHUB_ISSUE_ORDER);
  const [narrowing, setNarrowing] = useState<GitHubIssueListNarrowing>(NO_GITHUB_ISSUE_NARROWING);
  const fetched = listQuery.data?.entries ?? NO_ENTRIES;
  const facets = useMemo(() => gitHubIssueFacets(fetched), [fetched]);
  const entries = useMemo(
    () => applyGitHubIssueListView(fetched, narrowing, order),
    [fetched, narrowing, order],
  );
  const narrowed = !gitHubIssueNarrowingIsEmpty(narrowing);
  const narrowingProps = {
    types: facets.types,
    labels: facets.labels,
    narrowing,
    onNarrowing: setNarrowing,
  };
  // Stable, so the memoized rows skip a render when only the selection or the query moved.
  const filterBy = useCallback(
    (field: GitHubIssueFilterField, name: string) =>
      setNarrowing((previous) => toggleGitHubIssueNarrowing(previous, field, name)),
    [],
  );
  const refreshing = listQuery.isPending;
  const refresh = () => {
    listQuery.refresh();
    detailQuery.refresh();
  };
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
    <GitHubIssueListGhosts query={sentQuery} />
  ) : listQuery.data?.environmentErrors.length && fetched.length === 0 ? (
    <GitHubIssueEmptyState
      title="Could not load issues"
      description={
        listQuery.data.environmentErrors[0]?.message ?? "The environment did not answer."
      }
      action={<Button onClick={listQuery.refresh}>Try again</Button>}
    />
  ) : fetched.length === 0 && (listQuery.data?.errors.length ?? 0) > 0 ? (
    <GitHubIssueEmptyState
      title="Could not load issues"
      description={listQuery.data?.errors[0]?.message ?? "GitHub did not answer."}
      action={<Button onClick={listQuery.refresh}>Try again</Button>}
    />
  ) : entries.length === 0 && narrowed ? (
    <GitHubIssueEmptyState
      title="No issues"
      description={`The type and label filters hide all ${fetched.length} loaded issues.`}
      action={
        <Button variant="outline" onClick={() => setNarrowing(NO_GITHUB_ISSUE_NARROWING)}>
          Clear filters
        </Button>
      }
    />
  ) : entries.length === 0 ? (
    <GitHubIssueEmptyState
      title="No issues"
      description={search.q ? "Nothing matched this search." : "No issues matched these filters."}
    />
  ) : (
    <section aria-label={`${GROUP_LABELS[search.state]} issues`}>
      <GitHubIssueGroupHeader state={search.state} count={entries.length} />
      {/* Rows are not virtualized: each environment/project query is capped at 50, and rows use content-visibility:auto. */}
      <div className="space-y-0.5">
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
            onFilter={filterBy}
            onSelect={selectIssue}
          />
        ))}
      </div>
      {listQuery.data?.truncated ? (
        <p className="flex justify-center py-3 text-muted-foreground text-xs">
          Showing the newest 50 issues. Narrow the list with search or filters.
        </p>
      ) : null}
    </section>
  );

  const detail = !selectedRef ? null : selectedEnvironmentUnavailable ? (
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
      refreshing={detailQuery.isPending}
      onRefresh={detailQuery.refresh}
      onRetry={detailQuery.refresh}
      onSelectSubIssue={(child) =>
        updateSearch({
          selectedEnvironmentId: selectedRef.environmentId,
          selectedProjectId: selectedRef.projectId,
          repository: selectedRef.repository,
          number: child.number,
        })
      }
    />
  );

  const controls = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* fork-hook: workspaces/chooser-scope-label */}
        <ProjectChooserScopeLabelFork />
        {/* fork-hook-end */}
        {/* The field's own minimum, so a crowded row wraps its controls rather than overlapping them. */}
        <div ref={searchRef} className="min-w-48 basis-full @lg/issues:basis-0 @lg/issues:flex-1">
          <GitHubIssueSearchField
            value={search.q ?? ""}
            onChange={(next) => updateFilters({ q: next || undefined })}
          />
        </div>
        <GitHubIssueFilterAdd {...narrowingProps} />
        <GitHubIssueStateToggle
          state={search.state}
          onState={(next) => updateFilters({ state: next })}
        />
        <GitHubIssueProjectMenu
          projects={githubProjects}
          value={projectMenuValue}
          onValueChange={selectProject}
        />
        <GitHubIssueOrderMenu order={order} onOrder={setOrder} />
        <Button
          size="icon"
          variant="outline"
          aria-label="Refresh GitHub issues"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshIcon size="md" refreshing={refreshing} />
        </Button>
      </div>
      <GitHubIssueFilterBar {...narrowingProps} />
    </div>
  );

  const notices = [
    ...(listQuery.data?.errors.map((error) => ({
      key: `${error.environmentId}:${error.projectId}`,
      message: `${error.projectTitle}: ${error.message}`,
    })) ?? []),
    ...(listQuery.data?.environmentErrors.map((error) => ({
      key: error.environmentId,
      message: error.message,
    })) ?? []),
  ].map((notice) => (
    <div
      key={notice.key}
      role="status"
      className="rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-warning-foreground text-xs"
    >
      {notice.message}
    </div>
  ));

  if (variant === "panel") {
    return (
      <div
        className="@container/issues flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
        onKeyDown={onListKeyDown}
      >
        <div className="border-b border-border/70 p-3">{controls}</div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
          {notices}
          {body}
        </div>
      </div>
    );
  }

  const detailPanelOpen = selectedRef !== null && !isMobile;
  const selectedSurface = selectedRef === null ? null : githubIssueSurface(selectedRef);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        {/* The pull request page's column: flat background, shared header, in-flow controls. */}
        <div className="@container/issues flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={!detailPanelOpen}
            className="relative bg-background"
          >
            <WorkspaceBreadcrumb ariaLabel="GitHub issues breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">GitHub Issues</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer
              width="expanded"
              className="min-h-full gap-4"
              onKeyDown={onListKeyDown}
            >
              {controls}
              {notices}
              {body}
            </WorkspacePageContainer>
          </div>
        </div>

        {/* The pull request page's inline panel with the issue as its one tab: resizable, and
            closing the tab clears the selection. Kept out of the right-panel store, because the
            page's selection already lives in the route search. */}
        {detailPanelOpen && selectedSurface !== null ? (
          <RightPanelTabs
            mode="inline"
            open
            widthStorageKey="t3code:github-issue-panel-width"
            defaultWidth={typeof window === "undefined" ? 640 : Math.floor(window.innerWidth / 2)}
            surfaces={[selectedSurface]}
            environmentId={selectedRef.environmentId}
            activeSurfaceId={selectedSurface.id}
            pendingSurfaceIds={EMPTY_PENDING_SURFACES}
            previewSessions={EMPTY_PREVIEW_SESSIONS}
            desktopByTabId={EMPTY_PREVIEW_DESKTOP_STATE}
            terminalLabelsById={EMPTY_TERMINAL_LABELS}
            onActivate={() => undefined}
            onCloseSurface={closeDetail}
            onCloseOtherSurfaces={() => undefined}
            onCloseSurfacesToRight={() => undefined}
            onCloseAllSurfaces={closeDetail}
            onCopyFilePath={() => undefined}
            onAddBrowser={() => undefined}
            onAddBrowserInProfile={() => undefined}
            onAddTerminal={() => undefined}
            onAddDiff={() => undefined}
            onAddFiles={() => undefined}
            onAddPullRequest={() => undefined}
            onAddPullRequests={() => undefined}
            onAddIssues={() => undefined}
            onAddAgents={() => undefined}
            onAddDevice={() => undefined}
            browserAvailable={false}
            terminalAvailable={false}
            diffAvailable={false}
            filesAvailable={false}
            pullRequestAvailable={false}
            pullRequestsAvailable={false}
            issuesAvailable={false}
            agentsAvailable={false}
            deviceAvailable={false}
            liveAgentCount={0}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">{detail}</div>
          </RightPanelTabs>
        ) : null}
      </div>

      {selectedRef !== null && isMobile ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background pb-safe">
          <div className="sticky top-0 z-20 flex min-h-12 items-center border-b border-border bg-background/95 px-3 pt-safe backdrop-blur">
            <Button variant="ghost" size="sm" onClick={closeDetail}>
              <ArrowLeftIcon />
              Back to issues
            </Button>
          </div>
          {detail}
        </div>
      ) : null}
    </SidebarInset>
  );
}

const GROUP_LABELS = { open: "Open", closed: "Closed", all: "All" } as const satisfies Record<
  IssuesSearch["state"],
  string
>;

/** The pull request page's group header, holding the one group an issue list has: its state. */
function GitHubIssueGroupHeader({
  state,
  count,
}: {
  readonly state: IssuesSearch["state"];
  readonly count: number;
}) {
  const Icon = state === "all" ? LayersIcon : GITHUB_ISSUE_STATE_PRESENTATION[state].Icon;
  return (
    <div className="flex items-center gap-2 px-3 pb-1 font-medium text-muted-foreground/70 text-xs">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <h2 className="shrink-0">{GROUP_LABELS[state]}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{count}</span>
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}
