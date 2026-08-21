import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadShellExists: boolean;
  serverThreadDetailExists: boolean;
  serverThreadDetailDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.serverThreadDetailExists || input.draftThreadExists) {
    return "ready";
  }
  if (input.serverThreadDetailDeleted) {
    return "missing";
  }
  return input.serverThreadShellExists ? "loading" : "missing";
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

export function projectThreadRouteFamily(projectRef: ScopedProjectRef) {
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

/**
 * Resolves the thread represented by either a canonical thread route or a
 * draft route whose promotion to a server thread has been recorded.
 */
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
