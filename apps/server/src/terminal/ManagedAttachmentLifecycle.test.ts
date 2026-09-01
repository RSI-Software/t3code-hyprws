import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_MANAGED_ATTACHMENT_LIFECYCLE,
  transitionManagedAttachment,
  type ManagedAttachmentLifecycle,
} from "./ManagedAttachmentLifecycle.ts";

function transition(
  state: ManagedAttachmentLifecycle,
  action: Parameters<typeof transitionManagedAttachment>[1],
) {
  return transitionManagedAttachment(state, action);
}

describe("managed terminal attachment lifecycle", () => {
  it("does not suspend a managed open before demand has ever been acquired", () => {
    const managed = transition(INITIAL_MANAGED_ATTACHMENT_LIFECYCLE, {
      type: "managed-attached",
    });

    expect(managed.state).toMatchObject({
      phase: "attached",
      demand: 0,
      hasAcquiredDemand: false,
    });
    expect(managed.commands).toEqual([{ type: "cancel-suspend" }]);
  });

  it("cancels a pending suspension when demand returns", () => {
    const attached = transition(INITIAL_MANAGED_ATTACHMENT_LIFECYCLE, {
      type: "demand-added",
    }).state;
    const managed = transition(attached, { type: "managed-attached" }).state;
    const pending = transition(managed, { type: "demand-removed" });

    expect(pending.state).toMatchObject({
      phase: "suspend-pending",
      demand: 0,
    });
    expect(pending.commands.at(-1)).toMatchObject({ type: "schedule-suspend" });

    const shown = transition(pending.state, { type: "demand-added" });
    expect(shown.state).toMatchObject({ phase: "attached", demand: 1 });
    expect(shown.commands).toEqual([{ type: "cancel-suspend" }]);

    const staleTimer = transition(shown.state, {
      type: "suspend-elapsed",
      generation: pending.state.generation,
    });
    expect(staleTimer.state).toBe(shown.state);
    expect(staleTimer.commands).toEqual([]);
  });

  it("suspends only after the last independent surface releases demand", () => {
    const first = transition(INITIAL_MANAGED_ATTACHMENT_LIFECYCLE, {
      type: "demand-added",
    }).state;
    const second = transition(first, { type: "demand-added" }).state;
    const managed = transition(second, { type: "managed-attached" }).state;

    const oneHidden = transition(managed, { type: "demand-removed" });
    expect(oneHidden.state).toMatchObject({ phase: "attached", demand: 1 });
    expect(oneHidden.commands).toEqual([]);

    const allHidden = transition(oneHidden.state, { type: "demand-removed" });
    const elapsed = transition(allHidden.state, {
      type: "suspend-elapsed",
      generation: allHidden.state.generation,
    });
    expect(elapsed.state).toMatchObject({ phase: "suspended", demand: 0 });
    expect(elapsed.commands).toEqual([{ type: "suspend" }]);
  });

  it("coalesces repeated toggles and resumes once", () => {
    const suspended: ManagedAttachmentLifecycle = {
      phase: "suspended",
      demand: 0,
      generation: 4,
      hasAcquiredDemand: true,
    };
    const firstShow = transition(suspended, { type: "demand-added" });
    const secondShow = transition(firstShow.state, { type: "demand-added" });

    expect(firstShow.state.phase).toBe("resuming");
    expect(firstShow.commands).toContainEqual({ type: "resume" });
    expect(secondShow.state).toMatchObject({ phase: "resuming", demand: 2 });
    expect(secondShow.commands).not.toContainEqual({ type: "resume" });

    const resumed = transition(secondShow.state, { type: "resume-succeeded" });
    expect(resumed.state).toMatchObject({ phase: "attached", demand: 2 });
  });

  it("allows a later visibility change to retry a failed resume", () => {
    const resuming = transition(
      { phase: "suspended", demand: 0, generation: 2, hasAcquiredDemand: true },
      { type: "demand-added" },
    ).state;
    const failed = transition(resuming, { type: "resume-failed" });
    const hidden = transition(failed.state, { type: "demand-removed" }).state;
    const retry = transition(hidden, { type: "demand-added" });

    expect(failed.state.phase).toBe("resume-failed");
    expect(retry.state.phase).toBe("resuming");
    expect(retry.commands).toContainEqual({ type: "resume" });
  });
});
