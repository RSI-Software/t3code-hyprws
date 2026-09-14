// Fork-owned composer custom-agent render helpers (RSI-Software/t3code-hyprws#674).
// Everything here was woven into composerProviderState.tsx; the upstream file
// keeps only the marked re-export.
import type { ReactNode } from "react";

import { AgentMenuContent, AgentPicker, shouldRenderAgentControl } from "./AgentPicker.fork";
import { renderProviderTraitsPicker } from "./composerProviderState";

/** Structural mirror of the upstream file's private `TraitsRenderInput`. */
type TraitsRenderInput = Parameters<typeof renderProviderTraitsPicker>[0];

function renderAgentControl(
  Component: typeof AgentMenuContent | typeof AgentPicker,
  input: TraitsRenderInput,
): ReactNode {
  const { provider, instanceId, threadRef, draftId, model, models, modelOptions, planModeEnabled } =
    input;
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
      planModeEnabled={planModeEnabled}
    />
  );
}

export function renderProviderAgentMenuContent(input: TraitsRenderInput): ReactNode {
  return renderAgentControl(AgentMenuContent, input);
}

export function renderProviderAgentPicker(input: TraitsRenderInput): ReactNode {
  return renderAgentControl(AgentPicker, input);
}
