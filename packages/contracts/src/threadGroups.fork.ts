// Fork-owned sidebar thread groups (thread-ordering). A group belongs to one
// environment and lives in the server's `fork_thread_groups` table, outside the
// event-sourced thread payload: a group spans threads, while orchestrator
// commands are keyed to one thread. Only the fork RPCs and MCP tools carry
// groups, so the upstream app never decodes one.
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadGroupIdFork = TrimmedNonEmptyString;
export type ThreadGroupIdFork = typeof ThreadGroupIdFork.Type;

export const ThreadGroupFork = Schema.Struct({
  id: ThreadGroupIdFork,
  title: TrimmedNonEmptyString,
  /** At least two; a thread belongs to at most one group. */
  threadIds: Schema.Array(ThreadId),
  /** A member shown first, with the rest indented under it. Visual only. */
  parentThreadId: Schema.optionalKey(ThreadId),
});
export type ThreadGroupFork = typeof ThreadGroupFork.Type;

export const ThreadGroupsSnapshotFork = Schema.Struct({
  groups: Schema.Array(ThreadGroupFork),
});
export type ThreadGroupsSnapshotFork = typeof ThreadGroupsSnapshotFork.Type;

export const ThreadGroupMembershipTargetFork = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("existing"),
    groupId: ThreadGroupIdFork,
    /** The first joining thread becomes the group's parent. */
    asParent: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("new"),
    /** Client-chosen so an optimistic update can name the group; generated when absent. */
    groupId: Schema.optionalKey(ThreadGroupIdFork),
    title: TrimmedNonEmptyString,
    /** The first thread becomes the new group's parent. */
    asParent: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("none") }),
]);
export type ThreadGroupMembershipTargetFork = typeof ThreadGroupMembershipTargetFork.Type;

/** The changes an agent or a user makes; `import` stays a client-only mutation. */
export const ThreadGroupEditFork = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("set-membership"),
    threadIds: Schema.NonEmptyArray(ThreadId),
    target: ThreadGroupMembershipTargetFork,
  }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    groupId: ThreadGroupIdFork,
    title: TrimmedNonEmptyString,
    /** Rename only while the group still has this title and these members. */
    expected: Schema.optionalKey(
      Schema.Struct({ title: Schema.String, threadIds: Schema.Array(ThreadId) }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("set-parent"),
    groupId: ThreadGroupIdFork,
    parentThreadId: Schema.NullOr(ThreadId),
  }),
  Schema.Struct({ type: Schema.Literal("remove"), groupId: ThreadGroupIdFork }),
]);
export type ThreadGroupEditFork = typeof ThreadGroupEditFork.Type;

export const ThreadGroupMutationFork = Schema.Union([
  ...ThreadGroupEditFork.members,
  /** Adopts groups a client kept locally; skips known ids and already grouped threads. */
  Schema.Struct({ type: Schema.Literal("import"), groups: Schema.Array(ThreadGroupFork) }),
]);
export type ThreadGroupMutationFork = typeof ThreadGroupMutationFork.Type;

/** Where an agent-launched thread lands in the sidebar. */
export const ThreadLaunchGroupFork = Schema.Union([
  Schema.Literals(["caller", "none"]),
  Schema.Struct({ groupId: ThreadGroupIdFork }),
]).annotate({
  description:
    'Sidebar group for the new thread. "caller" (default) joins the calling thread\'s group when it has one; {groupId} joins that group from t3_thread_group_list; "none" leaves it ungrouped.',
});
export type ThreadLaunchGroupFork = typeof ThreadLaunchGroupFork.Type;

export class ThreadGroupErrorFork extends Schema.TaggedError<ThreadGroupErrorFork>()(
  "ThreadGroupErrorFork",
  { message: TrimmedNonEmptyString },
) {}

export type ThreadGroupMutationResultFork =
  | { readonly groups: ReadonlyArray<ThreadGroupFork> }
  | { readonly error: string };

/** Moves the threads out of every group, then into the target. Groups under two members dissolve. */
function setMembership(
  groups: ReadonlyArray<ThreadGroupFork>,
  threadIds: ReadonlyArray<ThreadId>,
  target: ThreadGroupMembershipTargetFork,
  newGroupId: () => string,
): ThreadGroupMutationResultFork {
  const moving = [...new Set(threadIds)];
  const movingIds = new Set(moving);
  if (target.type === "existing" && !groups.some((group) => group.id === target.groupId)) {
    return { error: `Unknown thread group ${target.groupId}.` };
  }
  if (target.type === "new" && moving.length < 2) {
    return { error: "A new thread group needs at least two threads." };
  }
  if (
    target.type === "new" &&
    target.groupId !== undefined &&
    groups.some((group) => group.id === target.groupId)
  ) {
    return { error: `Thread group ${target.groupId} already exists.` };
  }
  let next = groups.map((group): ThreadGroupFork => {
    const { parentThreadId, ...rest } = group;
    return {
      ...rest,
      threadIds: group.threadIds.filter((threadId) => !movingIds.has(threadId)),
      // A parent that leaves its group stops leading it.
      ...(parentThreadId === undefined || movingIds.has(parentThreadId) ? {} : { parentThreadId }),
    };
  });
  if (target.type === "existing") {
    next = next.map((group) =>
      group.id === target.groupId
        ? {
            ...group,
            threadIds: [...group.threadIds, ...moving],
            ...(target.asParent ? { parentThreadId: moving[0]! } : {}),
          }
        : group,
    );
  } else if (target.type === "new") {
    next.push({
      id: target.groupId ?? newGroupId(),
      title: target.title,
      threadIds: moving,
      ...(target.asParent ? { parentThreadId: moving[0]! } : {}),
    });
  }
  return { groups: next.filter((group) => group.threadIds.length >= 2) };
}

function importGroups(
  groups: ReadonlyArray<ThreadGroupFork>,
  incoming: ReadonlyArray<ThreadGroupFork>,
): ReadonlyArray<ThreadGroupFork> {
  const groupIds = new Set(groups.map((group) => group.id));
  const grouped = new Set(groups.flatMap((group) => group.threadIds));
  const next = [...groups];
  for (const candidate of incoming) {
    if (groupIds.has(candidate.id)) continue;
    const threadIds = [...new Set(candidate.threadIds)].filter((id) => !grouped.has(id));
    if (threadIds.length < 2) continue;
    for (const id of threadIds) grouped.add(id);
    groupIds.add(candidate.id);
    const { parentThreadId, ...rest } = candidate;
    next.push({
      ...rest,
      threadIds,
      ...(parentThreadId !== undefined && threadIds.includes(parentThreadId)
        ? { parentThreadId }
        : {}),
    });
  }
  return next;
}

/**
 * The one implementation of group semantics: the server applies it under its
 * write lock and clients apply it optimistically. Callers validate that the
 * named threads exist; a rename whose `expected` no longer matches is a no-op.
 */
export function applyThreadGroupMutationFork(
  groups: ReadonlyArray<ThreadGroupFork>,
  mutation: ThreadGroupMutationFork,
  newGroupId: () => string,
): ThreadGroupMutationResultFork {
  switch (mutation.type) {
    case "set-membership":
      return setMembership(groups, mutation.threadIds, mutation.target, newGroupId);
    case "import":
      return { groups: importGroups(groups, mutation.groups) };
    case "remove":
      return { groups: groups.filter((group) => group.id !== mutation.groupId) };
  }
  const group = groups.find((candidate) => candidate.id === mutation.groupId);
  if (group === undefined) return { error: `Unknown thread group ${mutation.groupId}.` };
  let next: ThreadGroupFork = group;
  if (mutation.type === "rename") {
    const { expected } = mutation;
    const stale =
      expected !== undefined &&
      (group.title !== expected.title ||
        group.threadIds.length !== expected.threadIds.length ||
        expected.threadIds.some((threadId) => !group.threadIds.includes(threadId)));
    if (!stale) next = { ...group, title: mutation.title };
  } else {
    const { parentThreadId: _previous, ...rest } = group;
    if (mutation.parentThreadId === null) {
      next = rest;
    } else if (group.threadIds.includes(mutation.parentThreadId)) {
      next = { ...rest, parentThreadId: mutation.parentThreadId };
    } else {
      return { error: `Thread ${mutation.parentThreadId} is not in group ${group.id}.` };
    }
  }
  return { groups: groups.map((candidate) => (candidate.id === group.id ? next : candidate)) };
}
