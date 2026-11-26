import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type CollaboratorMessageFork, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarRowStatus } from "../Sidebar.logic";
import {
  collaboratorRequestKeyFork,
  groupCollaboratorRequestsFork,
  liftCollaboratorRequestsFork,
  requestedFamiliesToMountFork,
  withCollaboratorRequestsFork,
} from "./collaboratorRequests.logic.fork";

const host = EnvironmentId.make("host");

const thread = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  ({
    environmentId: host,
    id: ThreadId.make(id),
    createdAt: "2026-11-25T08:00:00.000Z",
    pendingGuestMessageCount: 0,
    settledOverride: "settled",
    settledAt: "2026-11-25T08:10:00.000Z",
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestRun: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    ...overrides,
  }) as EnvironmentThreadShell;

const request = (threadId: string): CollaboratorMessageFork => ({
  id: `${threadId}-alex`,
  threadId: ThreadId.make(threadId),
  subject: "colleague:alex",
  name: "Alex",
  text: "Can you also cover negative divisors?",
  submittedAt: "2026-11-25T09:00:00.000Z",
});

describe("collaborator requests on the host's sidebar", () => {
  it.each([
    // The shells leave an older settled thread out, so its family is read while the request waits.
    { name: "requested, unloaded", requested: true, loaded: false, mounted: false, read: true },
    { name: "requested, read in", requested: true, loaded: true, mounted: true, read: true },
    { name: "requested, loaded", requested: true, loaded: true, mounted: false, read: false },
    { name: "answered", requested: false, loaded: true, mounted: true, read: false },
    { name: "own copy", requested: true, loaded: true, mounted: false, read: false, copy: true },
  ])("$name", ({ requested, loaded, mounted, read, copy }) => {
    const card = thread("divide", copy ? { collaboratorFork: "approve" } : {});
    const key = collaboratorRequestKeyFork(card);
    const waiting = groupCollaboratorRequestsFork(
      new Map([[host, requested ? [request("divide")] : []]]),
    );

    expect(
      requestedFamiliesToMountFork({
        requested: waiting.keys(),
        loaded: new Set(loaded ? [key] : []),
        mounted: mounted ? [key] : [],
      }),
    ).toEqual(read ? [key] : []);

    const shown = withCollaboratorRequestsFork(card, waiting.get(key));
    if (requested && !copy) {
      // Active with the Requested pill for display only; settlement is never written.
      expect(shown.settledOverride).toBeNull();
      expect(resolveSidebarRowStatus(shown)).toBe("request");
      expect(shown.collaboratorRequestersFork).toEqual(["Alex"]);
    } else {
      // Settlement decides: the same row comes back.
      expect(shown).toBe(card);
    }
  });

  it("a running thread with a request leaves the Working shelf for Active", () => {
    const running = thread("divide", { settledOverride: null, settledAt: null });
    const busy = thread("other", { settledOverride: null, settledAt: null });
    const requested = withCollaboratorRequestsFork(running, [request("divide")]);
    const active: EnvironmentThreadShell[] = [];
    const working = [requested, busy];

    liftCollaboratorRequestsFork(active, working);

    expect(active).toEqual([requested]);
    expect(working).toEqual([busy]);
  });
});
