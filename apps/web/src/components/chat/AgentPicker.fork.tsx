import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { BotIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";
import type { VariantProps } from "class-variance-authority";

import { useComposerDraftStore } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { buttonVariants } from "../ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import {
  DefaultBadge,
  replaceDescriptorCurrentValue,
  type TraitsPersistence,
} from "./TraitsPicker";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

const AGENT_DESCRIPTION_MAX_LENGTH = 120;

export function truncateAgentDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/g, " ");
  const firstPeriodIndex = normalized.indexOf(".");
  const firstSentence =
    firstPeriodIndex === -1 ? normalized : normalized.slice(0, firstPeriodIndex + 1);
  if (firstSentence.length <= AGENT_DESCRIPTION_MAX_LENGTH) {
    return firstSentence;
  }

  const candidate = firstSentence.slice(0, AGENT_DESCRIPTION_MAX_LENGTH - 1).trimEnd();
  const lastSpaceIndex = candidate.lastIndexOf(" ");
  const truncated =
    lastSpaceIndex >= AGENT_DESCRIPTION_MAX_LENGTH / 2
      ? candidate.slice(0, lastSpaceIndex)
      : candidate;
  return `${truncated}…`;
}

export interface AgentControlProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  planModeEnabled: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

function getAgentState(input: AgentControlProps) {
  const capabilities = getProviderModelCapabilities(
    input.models,
    input.model,
    input.provider,
    input.planModeEnabled,
  );
  const descriptors = getProviderOptionDescriptors({
    caps: capabilities,
    selections: input.modelOptions,
  });
  const descriptor =
    descriptors.find(
      (candidate): candidate is Extract<ProviderOptionDescriptor, { type: "select" }> =>
        candidate.type === "select" && candidate.id === "agent",
    ) ?? null;
  return { descriptor, descriptors };
}

export function shouldRenderAgentControl(input: AgentControlProps): boolean {
  return getAgentState(input).descriptor !== null;
}

export const AgentMenuContent = memo(function AgentMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  planModeEnabled,
  ...persistence
}: AgentControlProps & TraitsPersistence) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      const target = persistence.threadRef ?? persistence.draftId;
      if (!target) {
        return;
      }
      setProviderModelOptions(target, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );
  const { descriptor, descriptors } = getAgentState({
    provider,
    ...(instanceId ? { instanceId } : {}),
    models,
    model,
    modelOptions,
    planModeEnabled,
  });
  if (!descriptor) {
    return null;
  }

  const selectedValue = getProviderOptionCurrentValue(descriptor);
  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
        {descriptor.label}
      </div>
      <MenuRadioGroup
        value={typeof selectedValue === "string" ? selectedValue : ""}
        onValueChange={(value) => {
          if (!value) return;
          updateModelOptions(
            buildProviderOptionSelectionsFromDescriptors(
              replaceDescriptorCurrentValue(descriptors, descriptor.id, value),
            ),
          );
        }}
      >
        {descriptor.options.map((option) => {
          const description = option.description
            ? truncateAgentDescription(option.description)
            : null;
          return (
            <MenuRadioItem key={option.id} value={option.id} hideIndicator closeOnClick>
              <span className="flex w-full min-w-0 flex-col">
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {option.label}
                    {option.isDefault ? (
                      <>
                        {" "}
                        <DefaultBadge />
                      </>
                    ) : null}
                  </span>
                </span>
                {description ? (
                  <span className="max-w-72 break-words text-pretty text-muted-foreground/80 text-xs">
                    {description}
                  </span>
                ) : null}
              </span>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
    </MenuGroup>
  );
});

export const AgentPicker = memo(function AgentPicker({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  planModeEnabled,
  triggerVariant,
  triggerClassName,
  ...persistence
}: AgentControlProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { descriptor } = getAgentState({
    provider,
    ...(instanceId ? { instanceId } : {}),
    models,
    model,
    modelOptions,
    planModeEnabled,
  });
  if (!descriptor) {
    return null;
  }

  const label = getProviderOptionCurrentLabel(descriptor) ?? "Default";
  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            variant={triggerVariant ?? "ghost"}
            className={cn(
              "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48",
              triggerClassName,
            )}
            aria-label={`Agent: ${label}`}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-1.5 overflow-hidden">
          <ComposerControlIcon icon={BotIcon} className="opacity-80" />
          <span className="min-w-0 truncate">{label}</span>
          <ComposerControlChevron />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64 max-w-80">
        <AgentMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          modelOptions={modelOptions}
          planModeEnabled={planModeEnabled}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
