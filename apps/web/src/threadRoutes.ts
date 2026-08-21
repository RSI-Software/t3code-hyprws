import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";
import { resolveProjectRouteRef } from "./projectRoutes";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type ThreadRouteParams = Partial<
  Record<"environmentId" | "projectId" | "threadId" | "draftId", string | undefined>
>;

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | null | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (input.draftThreadExists || (input.serverThreadExists && !input.serverThreadDeleted)) {
    return "ready";
  }
  if (!input.bootstrapComplete) {
    return "loading";
  }
  return "missing";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

/** Whether a (decoded) location pathname is `ref`'s own thread route, `/$environmentId/$threadId`. */
export function isThreadRoutePathname(pathname: string, ref: ScopedThreadRef): boolean {
  const { environmentId, threadId } = buildThreadRouteParams(ref);
  return pathname.replace(/\/$/, "") === `/${environmentId}/${threadId}`;
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export const hubThreadRouteFamily = {
  kind: "hub" as const,
  thread: (threadRef: ScopedThreadRef) => ({
    to: "/$environmentId/$threadId" as const,
    params: buildThreadRouteParams(threadRef),
  }),
  draft: (draftId: DraftId) => ({
    to: "/draft/$draftId" as const,
    params: buildDraftThreadRouteParams(draftId),
  }),
  index: () => ({ to: "/" as const }),
};

function projectThreadRouteFamily(projectRef: ScopedProjectRef) {
  return {
    kind: "project" as const,
    projectRef,
    thread: (threadRef: ScopedThreadRef) => ({
      to: "/project/$environmentId/$projectId/thread/$threadId" as const,
      params: {
        environmentId: projectRef.environmentId,
        projectId: projectRef.projectId,
        threadId: threadRef.threadId,
      },
    }),
    draft: (draftId: DraftId) => ({
      to: "/project/$environmentId/$projectId/draft/$draftId" as const,
      params: {
        environmentId: projectRef.environmentId,
        projectId: projectRef.projectId,
        draftId,
      },
    }),
    index: () => ({
      to: "/project/$environmentId/$projectId" as const,
      params: {
        environmentId: projectRef.environmentId,
        projectId: projectRef.projectId,
      },
    }),
  };
}

export type ThreadRouteFamily =
  | typeof hubThreadRouteFamily
  | ReturnType<typeof projectThreadRouteFamily>;

/** Selects the navigation family represented by the current route params. */
export function resolveThreadRouteFamily(params: ThreadRouteParams): ThreadRouteFamily {
  const projectRef = resolveProjectRouteRef(params);
  return projectRef ? projectThreadRouteFamily(projectRef) : hubThreadRouteFamily;
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}
