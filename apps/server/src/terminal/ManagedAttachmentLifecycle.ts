export type ManagedAttachmentPhase =
  | "unmanaged"
  | "attached"
  | "first-attach-pending"
  | "suspend-pending"
  | "suspended"
  | "resuming"
  | "resume-failed";

export interface ManagedAttachmentLifecycle {
  readonly phase: ManagedAttachmentPhase;
  readonly demand: number;
  readonly generation: number;
  /** Selects the long first-attach deadline until UI demand has existed once. */
  readonly hasAcquiredDemand: boolean;
}

export type ManagedAttachmentAction =
  | { readonly type: "managed-attached" }
  | { readonly type: "unmanaged" }
  | { readonly type: "demand-added" }
  | { readonly type: "demand-removed" }
  | { readonly type: "first-attach-elapsed"; readonly generation: number }
  | { readonly type: "suspend-elapsed"; readonly generation: number }
  | { readonly type: "resume-succeeded" }
  | { readonly type: "resume-failed" }
  | { readonly type: "process-exited" };

export type ManagedAttachmentCommand =
  | { readonly type: "cancel-suspend" }
  | { readonly type: "schedule-first-attach"; readonly generation: number }
  | { readonly type: "schedule-suspend"; readonly generation: number }
  | { readonly type: "suspend" }
  | { readonly type: "resume" };

export interface ManagedAttachmentTransition {
  readonly state: ManagedAttachmentLifecycle;
  readonly commands: ReadonlyArray<ManagedAttachmentCommand>;
}

export const INITIAL_MANAGED_ATTACHMENT_LIFECYCLE: ManagedAttachmentLifecycle = Object.freeze({
  phase: "unmanaged",
  demand: 0,
  generation: 0,
  hasAcquiredDemand: false,
});

function scheduleFirstAttach(state: ManagedAttachmentLifecycle): ManagedAttachmentTransition {
  const generation = state.generation + 1;
  return {
    state: { ...state, phase: "first-attach-pending", generation },
    commands: [{ type: "cancel-suspend" }, { type: "schedule-first-attach", generation }],
  };
}

function scheduleSuspend(state: ManagedAttachmentLifecycle): ManagedAttachmentTransition {
  const generation = state.generation + 1;
  return {
    state: { ...state, phase: "suspend-pending", generation },
    commands: [{ type: "cancel-suspend" }, { type: "schedule-suspend", generation }],
  };
}

export function transitionManagedAttachment(
  state: ManagedAttachmentLifecycle,
  action: ManagedAttachmentAction,
): ManagedAttachmentTransition {
  switch (action.type) {
    case "managed-attached": {
      const attached = { ...state, phase: "attached" as const };
      if (attached.demand > 0) {
        return { state: attached, commands: [{ type: "cancel-suspend" }] };
      }
      return attached.hasAcquiredDemand ? scheduleSuspend(attached) : scheduleFirstAttach(attached);
    }
    case "unmanaged":
      return {
        state: {
          ...state,
          phase: "unmanaged",
          generation: state.generation + 1,
          hasAcquiredDemand: false,
        },
        commands: [{ type: "cancel-suspend" }],
      };
    case "demand-added": {
      const demanded = {
        ...state,
        demand: state.demand + 1,
        generation: state.generation + 1,
        hasAcquiredDemand: true,
      };
      if (state.phase === "suspended" || state.phase === "resume-failed") {
        return {
          state: { ...demanded, phase: "resuming" },
          commands: [{ type: "cancel-suspend" }, { type: "resume" }],
        };
      }
      return {
        state: {
          ...demanded,
          phase:
            state.phase === "suspend-pending" || state.phase === "first-attach-pending"
              ? "attached"
              : state.phase,
        },
        commands: [{ type: "cancel-suspend" }],
      };
    }
    case "demand-removed": {
      const demand = Math.max(0, state.demand - 1);
      const released = { ...state, demand };
      return demand === 0 && state.phase === "attached"
        ? scheduleSuspend(released)
        : { state: released, commands: [] };
    }
    case "first-attach-elapsed":
      if (
        state.phase !== "first-attach-pending" ||
        state.demand !== 0 ||
        state.hasAcquiredDemand ||
        state.generation !== action.generation
      ) {
        return { state, commands: [] };
      }
      return {
        state: { ...state, phase: "suspended" },
        commands: [{ type: "suspend" }],
      };
    case "suspend-elapsed":
      if (
        state.phase !== "suspend-pending" ||
        state.demand !== 0 ||
        state.generation !== action.generation
      ) {
        return { state, commands: [] };
      }
      return {
        state: { ...state, phase: "suspended" },
        commands: [{ type: "suspend" }],
      };
    case "resume-succeeded":
      return transitionManagedAttachment(
        { ...state, phase: "attached" },
        { type: "managed-attached" },
      );
    case "resume-failed":
      return {
        state: { ...state, phase: "resume-failed" },
        commands: [],
      };
    case "process-exited":
      return {
        state: {
          ...state,
          phase: "unmanaged",
          generation: state.generation + 1,
          hasAcquiredDemand: false,
        },
        commands: [{ type: "cancel-suspend" }],
      };
  }
}
