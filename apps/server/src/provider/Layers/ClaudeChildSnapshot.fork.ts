// custom-agents — extracted on RSI-Software/t3code-hyprws#674 PR 2.
//
// Completed child-assistant text that arrives before (or without) its
// task_started. The pending buffer, its bounded remember helper and the
// item.completed emitter live here so the adapter keeps one marked hook for
// the emitter and reuses the helpers through a single import.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventId, ProviderRuntimeEvent, RuntimeItemId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProviderAdapterRequestError } from "../Errors.ts";
import { truncateActivityDetail } from "../../activityDetail.ts";

export interface PendingClaudeAssistantSnapshot {
  readonly itemId: string;
  readonly detail: string;
}

function rememberPendingAssistantSnapshot(
  pending: Map<string, PendingClaudeAssistantSnapshot>,
  parentToolUseId: string,
  snapshot: PendingClaudeAssistantSnapshot,
  cap: number,
): void {
  pending.set(parentToolUseId, snapshot);
  if (pending.size > cap) {
    const oldest = pending.keys().next();
    if (!oldest.done) {
      pending.delete(oldest.value);
    }
  }
}

/** The session-context fields the emitter reads, kept structural on purpose. */
export interface ClaudeChildSnapshotContext {
  readonly session: { readonly threadId: ProviderRuntimeEvent["threadId"] };
  readonly turnState: { readonly turnId: TurnId } | undefined;
  readonly pendingAssistantSnapshots: Map<string, PendingClaudeAssistantSnapshot>;
}

export interface ClaudeChildSnapshotDeps {
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly asCanonicalTurnId: (value: TurnId) => TurnId;
  readonly asRuntimeItemId: (value: string) => RuntimeItemId;
  nativeProviderRefs(
    context: ClaudeChildSnapshotContext,
    options?: { readonly providerItemId?: string | undefined },
  ): NonNullable<ProviderRuntimeEvent["providerRefs"]>;
  extractAssistantTextBlocks(message: SDKMessage): Array<string>;
  sdkNativeItemId(message: SDKMessage): string | undefined;
  readonly pendingCap: number;
}

/**
 * Builds the adapter's child-assistant emitter. Closure vocabulary (stamps,
 * the runtime queue, provider refs) is injected, so the adapter constructs it
 * with one marked call and keeps upstream's emission shape.
 */
export function makeEmitChildAssistantSnapshot(deps: ClaudeChildSnapshotDeps) {
  const emit = Effect.fn("emitChildAssistantSnapshot")(function* (
    context: ClaudeChildSnapshotContext,
    input: {
      readonly taskId: string;
      readonly parentToolUseId: string;
      readonly snapshot: PendingClaudeAssistantSnapshot;
    },
  ) {
    const stamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: deps.provider,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: deps.asCanonicalTurnId(context.turnState.turnId) } : {}),
      itemId: deps.asRuntimeItemId(input.snapshot.itemId),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Agent message",
        detail: input.snapshot.detail,
        agentId: input.taskId,
        parentToolUseId: input.parentToolUseId,
        timelineBypass: true,
      },
      providerRefs: deps.nativeProviderRefs(context, {
        providerItemId: input.snapshot.itemId,
      }),
      raw: {
        source: "claude.sdk.message",
        method: "claude/assistant/child",
        payload: {
          taskId: input.taskId,
          parentToolUseId: input.parentToolUseId,
          itemId: input.snapshot.itemId,
        },
      },
    });
  });

  // Completed child text on an assistant snapshot: emit when the owning task
  // is known, otherwise hold it until task_started resolves the task id.
  const onAssistantMessage = Effect.fn("childSnapshotOnAssistantMessage")(function* (
    context: ClaudeChildSnapshotContext,
    input: {
      readonly message: SDKMessage;
      readonly owningTaskId: string | undefined;
      readonly parentToolUseId: string;
    },
  ) {
    const message = input.message as Extract<SDKMessage, { readonly type: "assistant" }>;
    const assistantText = deps.extractAssistantTextBlocks(message).join("\n\n").trim();
    const snapshot = assistantText
      ? {
          itemId: deps.sdkNativeItemId(message) ?? message.uuid,
          detail: truncateActivityDetail(assistantText),
        }
      : undefined;
    if (!snapshot) {
      return;
    }
    if (input.owningTaskId) {
      yield* emit(context, {
        taskId: input.owningTaskId,
        parentToolUseId: input.parentToolUseId,
        snapshot,
      });
    } else {
      rememberPendingAssistantSnapshot(
        context.pendingAssistantSnapshots,
        input.parentToolUseId,
        snapshot,
        deps.pendingCap,
      );
    }
  });

  // task_started resolves a pending child snapshot keyed by the task's
  // tool_use_id and emits it against the real task id.
  const onTaskStarted = Effect.fn("childSnapshotOnTaskStarted")(function* (
    context: ClaudeChildSnapshotContext,
    input: { readonly taskId: string; readonly toolUseId: string | undefined },
  ) {
    const pending = input.toolUseId
      ? context.pendingAssistantSnapshots.get(input.toolUseId)
      : undefined;
    if (input.toolUseId) {
      context.pendingAssistantSnapshots.delete(input.toolUseId);
    }
    if (input.toolUseId && pending) {
      yield* emit(context, {
        taskId: input.taskId,
        parentToolUseId: input.toolUseId,
        snapshot: pending,
      });
    }
  });

  return { emit, onAssistantMessage, onTaskStarted };
}
