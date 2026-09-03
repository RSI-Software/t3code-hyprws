import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderAgentMenuContent,
  renderProviderAgentPicker,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { DraftId } from "../../composerDraftStore";
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
function booleanDescriptor(id: string): Extract<
  ProviderOptionDescriptor,
  {
    type: "boolean";
  }
> {
  return { id, label: id, type: "boolean" };
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
const ULTRATHINK_FRAME_CLASSES = {
  composerFrameClassName: "ultrathink-frame",
  composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
  modelPickerIconClassName: "ultrathink-chroma",
} as const;
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
});
