// Fork-owned agent name on the composer model trigger (custom-agents).
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { BotIcon } from "lucide-react";
import type { ReactNode } from "react";

import { getTraitsSectionVisibility, type TraitsSelectionInput } from "./TraitsPicker";

/** The selected agent's label, or null for the default agent or none. */
export function nonDefaultAgentLabel(traits: TraitsSelectionInput | null): string | null {
  if (!traits) return null;
  const descriptor = getTraitsSectionVisibility(traits).agentDescriptor;
  if (!descriptor) return null;
  // The picker column's resolution: an explicit pick, else what the session reports.
  const selection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const value = getProviderOptionCurrentValue(descriptor, selection, traits.reportedModelSelection);
  const option = descriptor.options.find((candidate) => candidate.id === value);
  return option && !option.isDefault ? option.label : null;
}

/** Overrides the trigger suffix only when a non-default agent is selected. */
export function agentTriggerSuffixFork(
  suffix: ReactNode,
  traits: TraitsSelectionInput | null,
): { triggerSuffix?: ReactNode } {
  const label = nonDefaultAgentLabel(traits);
  if (!label) return {};
  return {
    triggerSuffix: (
      <>
        {suffix}
        <span className="flex min-w-0 shrink items-center gap-1 text-muted-foreground group-hover/model-trigger:text-foreground group-data-pressed/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground">
          <BotIcon aria-hidden="true" data-composer-control-icon className="size-3 shrink-0" />
          <span data-composer-control-label className="max-w-24 truncate">
            {label}
          </span>
        </span>
      </>
    ),
  };
}
