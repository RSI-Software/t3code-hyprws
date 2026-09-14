import { isValidElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getComposerProviderState,
  renderProviderAgentMenuContent,
  renderProviderAgentPicker,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { DraftId } from "../../composerDraftStore";
import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";
// Everything in composerProviderState is now data-driven by the model's
// optionDescriptors, so these tests use a single synthetic provider/model and
// vary only the descriptor shape per scenario.
const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("codex");
const OPENCODE_PROVIDER: ProviderDriverKind = ProviderDriverKind.make("opencode");
const MODEL = "test-model";
function selectDescriptor(
  id: string,
  options: ReadonlyArray<{
    id: string;
    label: string;
    isDefault?: boolean;
  }>,
  promptInjectedValues?: ReadonlyArray<string>,
): Extract<
  ProviderOptionDescriptor,
  {
    type: "select";
  }
> {
  const defaultId = options.find((option) => option.isDefault)?.id;
  return {
    id,
    label: id,
    type: "select",
    options: [...options],
    ...(defaultId ? { currentValue: defaultId } : {}),
    ...(promptInjectedValues && promptInjectedValues.length > 0
      ? { promptInjectedValues: [...promptInjectedValues] }
      : {}),
  };
}
function modelWith(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    { slug: MODEL, name: MODEL, isCustom: false, capabilities: { optionDescriptors: descriptors } },
  ];
}
function selections(
  ...entries: Array<[string, string | boolean]>
): ReadonlyArray<ProviderOptionSelection> {
  return entries.map(([id, value]) => ({ id, value }));
}
describe("getComposerProviderState legacy plan mode", () => {
  forkSupersedes({
    upstream:
      "apps/web/src/components/chat/composerProviderState.test.tsx > drops the plan agent from dispatch when legacy plan mode is disabled",
    reason:
      "only OpenCode hides its plan agent with legacy plan mode off; other providers keep plan as a selectable main-thread agent",
    commit: "cfe211a818a",
  });
  it("drops the plan agent from OpenCode dispatch when legacy plan mode is disabled", () => {
    const input = {
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: false,
    };
    expect(
      getComposerProviderState({ ...input, provider: OPENCODE_PROVIDER }).modelOptionsForDispatch,
    ).toEqual(selections(["agent", "build"]));
    expect(
      getComposerProviderState({ ...input, provider: PROVIDER }).modelOptionsForDispatch,
    ).toEqual(selections(["agent", "plan"]));
  });
  forkSupersedes({
    upstream:
      "apps/web/src/components/chat/composerProviderState.test.tsx > drops the agent descriptor entirely when plan is the only option and plan mode is disabled",
    reason:
      "only OpenCode hides its plan agent with legacy plan mode off; other providers keep plan as a selectable main-thread agent",
    commit: "cfe211a818a",
  });
  it("drops the OpenCode agent descriptor entirely when plan is the only option and plan mode is disabled", () => {
    const state = getComposerProviderState({
      provider: OPENCODE_PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [{ id: "plan", label: "Plan", isDefault: true }]),
      ]),
      modelOptions: selections(["agent", "plan"]),
      planModeEnabled: false,
    });
    expect(state).toEqual({
      provider: OPENCODE_PROVIDER,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    });
  });
});
describe("provider traits render guards", () => {
  it("renders an agent-only descriptor in its dedicated control", () => {
    const models = modelWith([
      selectDescriptor("agent", [
        { id: "default", label: "Default", isDefault: true },
        { id: "fable", label: "fable" },
      ]),
    ]);
    const args = {
      provider: PROVIDER,
      draftId: DraftId.make("draft-agent"),
      model: MODEL,
      models,
      modelOptions: selections(["agent", "fable"]),
      prompt: "",
      onPromptChange: () => {},
      planModeEnabled: false,
    };
    expect(renderProviderAgentPicker(args)).not.toBeNull();
    expect(renderProviderAgentMenuContent(args)).not.toBeNull();
    expect(renderProviderTraitsPicker(args)).toBeNull();
    expect(renderProviderTraitsMenuContent(args)).toBeNull();
  });

  // A dropped selection shows every agent as Default and rebuilds the other
  // traits from defaults on the next pick.
  it("hands the current selections to both agent controls", () => {
    const args = {
      provider: PROVIDER,
      draftId: DraftId.make("draft-agent-selection"),
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "default", label: "Default", isDefault: true },
          { id: "fable", label: "fable" },
        ]),
      ]),
      modelOptions: selections(["agent", "fable"]),
      prompt: "",
      onPromptChange: () => {},
      planModeEnabled: false,
    };
    for (const control of [renderProviderAgentPicker(args), renderProviderAgentMenuContent(args)]) {
      expect(isValidElement<{ modelOptions?: unknown }>(control)).toBe(true);
      if (!isValidElement<{ modelOptions?: unknown }>(control)) continue;
      expect(control.props.modelOptions).toEqual(args.modelOptions);
    }
  });
});
