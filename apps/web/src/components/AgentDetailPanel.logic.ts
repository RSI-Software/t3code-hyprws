import type {
  OrchestrationAgentActivity,
  OrchestrationAgentActivitySnapshot,
} from "@t3tools/contracts";

export const AGENT_DETAIL_MAX_RETAINED_ACTIVITIES = 200;

export function agentDetailIdentity(
  environmentId: string | null,
  threadId: string | null,
  agentId: string,
): string {
  return JSON.stringify([environmentId, threadId, agentId]);
}

export interface AgentDetailPaginationState {
  readonly generation: number;
  readonly activities: ReadonlyArray<OrchestrationAgentActivity>;
  readonly beforeCursor: string | null;
  readonly hasMore: boolean | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export type AgentDetailPaginationAction =
  | { readonly type: "reset"; readonly generation: number }
  | { readonly type: "load-started"; readonly generation: number }
  | {
      readonly type: "load-succeeded";
      readonly generation: number;
      readonly snapshot: OrchestrationAgentActivitySnapshot;
    }
  | {
      readonly type: "load-failed";
      readonly generation: number;
      readonly error: string;
    };

export function createAgentDetailPaginationState(generation = 0): AgentDetailPaginationState {
  return {
    generation,
    activities: [],
    beforeCursor: null,
    hasMore: null,
    loading: false,
    error: null,
  };
}

export function reduceAgentDetailPagination(
  state: AgentDetailPaginationState,
  action: AgentDetailPaginationAction,
): AgentDetailPaginationState {
  if (action.type === "reset") {
    return createAgentDetailPaginationState(action.generation);
  }
  if (action.generation !== state.generation) {
    return state;
  }
  if (action.type === "load-started") {
    return { ...state, loading: true, error: null };
  }
  if (action.type === "load-failed") {
    return { ...state, loading: false, error: action.error };
  }

  const seen = new Set<string>();
  const activities = [...action.snapshot.activities, ...state.activities]
    .filter((activity) => {
      if (seen.has(activity.id)) return false;
      seen.add(activity.id);
      return true;
    })
    .slice(-AGENT_DETAIL_MAX_RETAINED_ACTIVITIES);
  const retentionLimitReached = activities.length >= AGENT_DETAIL_MAX_RETAINED_ACTIVITIES;
  return {
    ...state,
    activities,
    beforeCursor: action.snapshot.page.beforeCursor,
    hasMore: retentionLimitReached ? false : action.snapshot.page.hasMore,
    loading: false,
    error: null,
  };
}

export function resolveAgentDetailPageWindow(
  state: AgentDetailPaginationState,
  latest: OrchestrationAgentActivitySnapshot | undefined,
): { readonly hasMore: boolean; readonly beforeCursor: string | null } {
  return {
    hasMore: state.hasMore ?? latest?.page.hasMore ?? false,
    beforeCursor: state.beforeCursor ?? latest?.page.beforeCursor ?? null,
  };
}
