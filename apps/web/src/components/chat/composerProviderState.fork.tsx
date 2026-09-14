// Fork-owned composer custom-agent render helpers (RSI-Software/t3code-hyprws#674).
// Everything here was woven into composerProviderState.tsx; the upstream file
// keeps only the marked re-export.
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { AgentMenuContent, AgentPicker, shouldRenderAgentControl } from "./AgentPicker.fork";
import type { TraitsSelectionInput } from "./TraitsPicker";

function renderAgentControl(
  Component: typeof AgentMenuContent | typeof AgentPicker,
  input: TraitsSelectionInput | null,
): ReactNode {
  if (!input) return null;
  const { provider, instanceId, threadRef, model, models, modelOptions, includePlanAgent } = input;
  const planModeEnabled = includePlanAgent === true;
  const draftId = "draftId" in input ? input.draftId : undefined;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderAgentControl({
      provider,
      models,
      model,
      planModeEnabled,
    })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      planModeEnabled={planModeEnabled}
    />
  );
}

export function renderProviderAgentMenuContent(input: TraitsSelectionInput | null): ReactNode {
  return renderAgentControl(AgentMenuContent, input);
}

export function renderProviderAgentPicker(input: TraitsSelectionInput | null): ReactNode {
  return renderAgentControl(AgentPicker, input);
}

/**
 * The agent picker leads the resting blocks and overflows last: only once every upstream block
 * has overflowed and the measurement still finds no room. It then moves into the overflow menu.
 */
export function agentBlockHiddenFork(input: {
  readonly measuredHiddenBlockCount: number;
  readonly upstreamBlockCount: number;
  readonly upstreamHiddenBlockCount: number;
}): boolean {
  return (
    input.upstreamHiddenBlockCount > 0 && input.measuredHiddenBlockCount > input.upstreamBlockCount
  );
}

/** The agent picker's resting block, or nothing when it does not render. */
export function agentRestingBlockFork(picker: ReactNode, hidden: boolean): ReactNode {
  if (!picker) return null;
  return (
    <div
      data-resting-block="agent"
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      className={cn(
        "flex w-max min-w-max shrink-0 items-center gap-1",
        hidden && "pointer-events-none invisible absolute",
      )}
    >
      {picker}
    </div>
  );
}
