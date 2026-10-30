// Fork-owned thread ↔ artifact links on Orchestrator V2, stored inside the thread payload.
// `Orchestrator.ts` routes the three artifact commands here through marked hooks; each emits the
// upstream `thread.metadata-updated` event with the whole thread, so no upstream client receives
// a fork-only event type. Links never settle a thread, and T3 never touches the linked files.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the pure decider cannot yield the Path service.
import * as NodePath from "node:path";

import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  ThreadArtifactLink,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

export type ThreadArtifactCommandFork = Extract<
  OrchestrationV2ServerCommand,
  { type: "thread.artifact.link" | "thread.artifact.unlink" | "thread.artifact.observe" }
>;

/** A thread's links; a thread from before links has none. */
const threadArtifactsOf = (thread: {
  readonly artifacts?: ReadonlyArray<ThreadArtifactLink>;
}): ReadonlyArray<ThreadArtifactLink> => thread.artifacts ?? [];

/** The thread's `artifacts` key: omitted when there are none, like a thread from before links. */
export const threadArtifactsField = (
  artifacts: ReadonlyArray<ThreadArtifactLink> | undefined,
): { readonly artifacts?: ReadonlyArray<ThreadArtifactLink> } =>
  artifacts === undefined || artifacts.length === 0 ? {} : { artifacts };

const withThreadArtifacts = (
  thread: OrchestrationV2AppThread,
  artifacts: ReadonlyArray<ThreadArtifactLink>,
): OrchestrationV2AppThread => {
  const { artifacts: _previous, ...rest } = thread;
  return { ...rest, ...threadArtifactsField(artifacts) };
};

/**
 * The thread an artifact command leaves, `null` when it changes nothing, or the reason it is
 * refused. An unlink of an unknown path and an observation that changes nothing write no event.
 */
const decideThreadArtifactCommandFork = (
  thread: OrchestrationV2AppThread,
  command: ThreadArtifactCommandFork,
  now: DateTime.Utc,
): OrchestrationV2AppThread | null | { readonly refused: string } => {
  if (thread.deletedAt !== null) {
    return { refused: `Thread ${command.threadId} is deleted.` };
  }
  if (!NodePath.posix.isAbsolute(command.path)) {
    return { refused: `Artifact path ${command.path} is not an absolute path.` };
  }
  const path = NodePath.posix.normalize(command.path);
  const links = threadArtifactsOf(thread);
  const existing = links.find((link) => link.path === path);
  switch (command.type) {
    case "thread.artifact.link": {
      const linkedNow = DateTime.formatIso(now);
      const link: ThreadArtifactLink = {
        path,
        title: command.title,
        source: command.source,
        linkedAt: existing?.linkedAt ?? linkedNow,
        updatedAt: linkedNow,
        missing: false,
      };
      const next =
        existing === undefined
          ? [...links, link]
          : links.map((it) => (it === existing ? link : it));
      return { ...withThreadArtifacts(thread, next), updatedAt: now };
    }
    case "thread.artifact.unlink":
      if (existing === undefined) return null;
      return {
        ...withThreadArtifacts(
          thread,
          links.filter((link) => link !== existing),
        ),
        updatedAt: now,
      };
    case "thread.artifact.observe":
      if (
        existing === undefined ||
        (existing.updatedAt === command.updatedAt && existing.missing === command.missing)
      ) {
        return null;
      }
      // A file change is not thread activity: the sidebar order stays put.
      return withThreadArtifacts(
        thread,
        links.map((link) =>
          link === existing
            ? { ...link, updatedAt: command.updatedAt, missing: command.missing }
            : link,
        ),
      );
  }
};

/** An unlink of an unknown path or an unchanged observation is accepted without an event. */
export const threadArtifactNoOpAcceptedFork = (command: OrchestrationV2ServerCommand): boolean =>
  command.type === "thread.artifact.unlink" || command.type === "thread.artifact.observe";

/**
 * Binds the orchestrator's thread read, event emitter and error mapping once, so its dispatch
 * hook stays one line and this module never imports `Orchestrator.ts` back.
 */
export const threadArtifactsDispatchFork = <E1, E2, R2, E3>(
  projectionStore: {
    readonly getThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E1>;
  },
  emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => (event: Omit<OrchestrationV2DomainEvent, "id">) => Effect.Effect<unknown, E2, R2>,
  mapError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E3, R>,
) =>
  Effect.fn("dispatchThreadArtifactCommandFork")(function* (
    command: ThreadArtifactCommandFork,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const thread = yield* mapError(command)(projectionStore.getThread(command.threadId));
    const now = yield* DateTime.now;
    const decided = decideThreadArtifactCommandFork(thread, command, now);
    if (decided === null) return;
    if ("refused" in decided) return yield* mapError(command)(Effect.fail(decided.refused));
    yield* emit(
      events,
      command,
    )({
      type: "thread.metadata-updated",
      threadId: command.threadId,
      providerInstanceId: decided.providerInstanceId,
      occurredAt: now,
      payload: decided,
    });
  });
