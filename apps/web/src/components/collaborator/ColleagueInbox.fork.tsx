// Fork-only (colleague-collab): the sidebar's inbox switch and a saved colleague's inbox: every thread
// my collaborator grant reads on their server. A thread opened here only asks: a request waits for them.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { EyeIcon, InboxIcon } from "lucide-react";

import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { useProjects, useQuietThreadShells, useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuerySelector } from "~/state/query";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarFolderDrop } from "../sidebar/SidebarFolderDrop";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { colleagueInboxAtom } from "./colleagueInbox.fork";
import { colleaguesAtom, colleaguesServedFork } from "./colleagues.fork";

const MINE = "mine";

/** The saved colleagues, and the one whose inbox the sidebar shows; a removed one shows mine. */
export function useColleagueInboxFork() {
  const primary = usePrimaryEnvironmentId();
  const served = colleaguesServedFork(useServerConfigs(), primary);
  const colleagues =
    useEnvironmentQuerySelector(
      served && primary !== null ? colleaguesAtom(primary) : null,
      selectEnvironmentQueryData,
    ) ?? [];
  const browsingId = useAtomValue(colleagueInboxAtom);
  const browsing = colleagues.find((colleague) => colleague.environmentId === browsingId) ?? null;
  return { colleagues, browsing };
}

type ColleagueInboxFork = ReturnType<typeof useColleagueInboxFork>;
type Colleague = ColleagueInboxFork["colleagues"][number];

export function ColleagueInboxSwitchFork({ inbox }: { readonly inbox: ColleagueInboxFork }) {
  const gt = useGT();
  const browse = useAtomSet(colleagueInboxAtom);
  if (inbox.colleagues.length === 0) return null;
  const items = {
    [MINE]: gt("My inbox"),
    ...Object.fromEntries(
      inbox.colleagues.map((colleague) => [colleague.environmentId, colleague.name]),
    ),
  };
  return (
    <div className="px-(--sidebar-content-inset) pt-(--sidebar-content-inset)">
      <Select
        value={inbox.browsing?.environmentId ?? MINE}
        items={items}
        onValueChange={(value) =>
          browse(value === MINE || value === null ? null : (value as EnvironmentId))
        }
      >
        <SelectTrigger
          size="sm"
          variant="ghost"
          aria-label={gt("Switch inbox")}
          className="w-full justify-start"
        >
          {inbox.browsing ? <EyeIcon aria-hidden /> : <InboxIcon aria-hidden />}
          <span className="min-w-0 flex-1 truncate">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectPopup>
          {Object.entries(items).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** The sidebar while I browse a colleague's inbox: my chrome around their threads, in place of mine. */
export function ColleagueSidebarFork({
  inbox,
  colleague,
}: {
  readonly inbox: ColleagueInboxFork;
  readonly colleague: Colleague;
}) {
  return (
    <SidebarFolderDrop>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={<ColleagueInboxSwitchFork inbox={inbox} />}
      >
        <ColleagueThreads environmentId={colleague.environmentId} name={colleague.name} />
      </SidebarContent>
      <SidebarChromeFooter />
    </SidebarFolderDrop>
  );
}

function ColleagueThreads({
  environmentId,
  name,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const route = resolveThreadRouteTarget(useParams({ strict: false }));
  const projectTitle = new Map(
    useProjects()
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title] as const),
  );
  const threads = useQuietThreadShells()
    .filter((thread) => thread.environmentId === environmentId)
    .map((thread) => ({ thread, activity: resolveThreadActivityTimestamp(thread) }))
    .toSorted((a, b) => (b.activity ?? "").localeCompare(a.activity ?? ""));
  return (
    <SidebarGroup>
      {threads.length === 0 ? (
        <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
          {gt("Nothing from {name} yet", { name })}
        </p>
      ) : (
        <ul aria-label={gt("{name}'s inbox", { name })} className="flex flex-col gap-px">
          {threads.map(({ thread, activity }) => {
            const active = route?.kind === "server" && route.threadRef.threadId === thread.id;
            const settled = thread.settledAt !== null;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(environmentId, thread.id)),
                    });
                  }}
                  className={cn(
                    "flex min-h-9 w-full cursor-pointer flex-col rounded-md px-2.5 py-1 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                    active
                      ? "bg-sidebar-row-active text-sidebar-foreground"
                      : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        settled
                          ? "font-normal text-secondary-label/70"
                          : "font-medium text-foreground",
                      )}
                    >
                      {thread.title}
                    </span>
                    {activity === null ? null : (
                      <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
                        {formatRelativeTimeLabel(activity, nowMs, messages)}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted-foreground/70">
                    {projectTitle.get(thread.projectId) ?? null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </SidebarGroup>
  );
}
