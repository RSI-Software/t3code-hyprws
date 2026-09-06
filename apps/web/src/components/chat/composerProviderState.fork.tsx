// Fork-owned composer custom-agent render helpers (RSI-Software/t3code-hyprws#674).
// Everything here was woven into composerProviderState.tsx; the upstream file
// keeps only the marked re-export.
import type { ReactNode } from "react";

import { AgentMenuContent, AgentPicker, shouldRenderAgentControl } from "./AgentPicker.fork";
import { ComposerControlSeparator } from "./ComposerControl";
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

/** The resting-block entry for the agent picker, or nothing when it does not render. */
export function agentRestingBlock(
  providerAgentPicker: ReactNode,
  composerControlsInStrip: boolean,
): Array<{ id: string; content: ReactNode }> {
  if (!providerAgentPicker) return [];
  return [
    {
      id: "agent",
      content: (
        <>
          <ComposerControlSeparator size={composerControlsInStrip ? "xs" : "sm"} />
          {providerAgentPicker}
        </>
      ),
    },
  ];
}
