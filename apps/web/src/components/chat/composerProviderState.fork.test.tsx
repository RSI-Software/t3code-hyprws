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
} from "./composerProviderState";
import { DraftId } from "../../composerDraftStore";
import { agentBlockHiddenFork } from "./composerProviderState.fork";
import { getTraitsSectionVisibility } from "./TraitsPicker";

it.each([
  { measured: 1, upstream: 1, upstreamHidden: 1, hidden: false },
  { measured: 2, upstream: 1, upstreamHidden: 1, hidden: true },
  { measured: 2, upstream: 0, upstreamHidden: 0, hidden: false },
])(
  "overflows the agent only after every upstream block (%o)",
  ({ measured, upstream, upstreamHidden, hidden }) => {
    expect(
      agentBlockHiddenFork({
        measuredHiddenBlockCount: measured,
        upstreamBlockCount: upstream,
        upstreamHiddenBlockCount: upstreamHidden,
      }),
    ).toBe(hidden);
  },
);
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
describe("getComposerProviderState plan agent", () => {
  forkSupersedes({
    upstream:
      "apps/web/src/components/chat/composerProviderState.test.tsx > drops the plan agent from dispatch unless it is included",
    reason:
      "only OpenCode hides its plan agent; other providers keep plan as a selectable main-thread agent",
    commit: "cfe211a818a",
  });
  it("drops the plan agent from dispatch unless it is included", () => {
    const input = {
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [
          { id: "build", label: "Build", isDefault: true },
          { id: "plan", label: "Plan" },
        ]),
      ]),
      modelOptions: selections(["agent", "plan"]),
    };
    const state = getComposerProviderState({ ...input, provider: OPENCODE_PROVIDER });
    expect(state.modelOptionsForDispatch).toEqual(selections(["agent", "build"]));
    expect(
      getComposerProviderState({ ...input, provider: PROVIDER }).modelOptionsForDispatch,
    ).toEqual(selections(["agent", "plan"]));
  });
  it("drops the OpenCode agent descriptor entirely when plan is the only option", () => {
    const state = getComposerProviderState({
      provider: OPENCODE_PROVIDER,
      model: MODEL,
      models: modelWith([
        selectDescriptor("agent", [{ id: "plan", label: "Plan", isDefault: true }]),
      ]),
      modelOptions: selections(["agent", "plan"]),
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
      promptUltrathink: "none" as const,
      onPromptEdit: () => {},
    };
    expect(renderProviderAgentPicker(args)).not.toBeNull();
    expect(renderProviderAgentMenuContent(args)).not.toBeNull();
    expect(getTraitsSectionVisibility(args).hasAnyControls).toBe(false);
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
      promptUltrathink: "none" as const,
      onPromptEdit: () => {},
    };
    for (const control of [renderProviderAgentPicker(args), renderProviderAgentMenuContent(args)]) {
      expect(isValidElement<{ modelOptions?: unknown }>(control)).toBe(true);
      if (!isValidElement<{ modelOptions?: unknown }>(control)) continue;
      expect(control.props.modelOptions).toEqual(args.modelOptions);
    }
  });
});
