import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getComposerProviderState } from "./composerProviderState";
import { DraftId } from "../../composerDraftStore";
import { nonDefaultAgentLabel } from "./agentTriggerSuffix.fork";
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

it.each([
  { agent: "default", label: null },
  { agent: "fable", label: "fable" },
  { agent: null, label: null },
])("names only a non-default agent on the trigger (%o)", ({ agent, label }) => {
  const models = modelWith(
    agent === null
      ? []
      : [
          selectDescriptor("agent", [
            { id: "default", label: "Default", isDefault: true },
            { id: "fable", label: "fable" },
          ]),
        ],
  );
  expect(
    nonDefaultAgentLabel({
      provider: PROVIDER,
      draftId: DraftId.make("draft-agent-trigger"),
      model: MODEL,
      models,
      modelOptions: agent === null ? [] : selections(["agent", agent]),
      promptUltrathink: "none",
      onPromptEdit: () => {},
    }),
  ).toBe(label);
});
