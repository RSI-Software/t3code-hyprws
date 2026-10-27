import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
  type VoiceTextConfigFork,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, render, type Screen } from "../../test/render";
import { useVoiceTextFork, type VoiceTextInputFork } from "./useVoiceText.fork";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  config: null as VoiceTextConfigFork | null,
  canOperate: true,
}));
vi.mock("./useVoiceSettings.fork", () => ({
  useVoiceTextSettingsFork: () => ({ settings: { defaults: mocks.config, projects: {} } }),
}));
vi.mock("../state/session", () => ({
  readPreparedConnection: () => ({}),
  useEnvironmentScope: () => mocks.canOperate,
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({
  transformVoiceTextFork: (_prepared: unknown, input: unknown) => input,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeAtomQuery: async (
    _registry: unknown,
    input: unknown,
    options: { signal?: AbortSignal },
  ) => {
    try {
      return AsyncResult.success(await mocks.request(input, options.signal));
    } catch (error) {
      return AsyncResult.failure(Cause.fail(error));
    }
  },
}));
vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: { atom: (input: unknown) => input },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

let screen: Screen;
let actions: ReturnType<typeof useVoiceTextFork>;
let draft: {
  text: string;
  ownerKey: string;
  revision: number;
  selection: { start: number; end: number };
};
let input: VoiceTextInputFork;
function Probe() {
  const value = useVoiceTextFork(input);
  useLayoutEffect(() => {
    actions = value;
  });
  return value.controls;
}
function errorText() {
  return screen.container.textContent ?? "";
}
async function click(label: string) {
  const button = screen.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`No ${label} button.`);
  await act(async () => button.click());
}
async function setup() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(console, "error").mockImplementation(() => {}));
  mocks.canOperate = true;
  mocks.config = {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    cleanupMode: "auto",
    formattingMode: "auto",
    formattingMinWords: 2,
    recentMessageCount: 0,
    projectContext: "",
    terms: "",
    ...VOICE_TEXT_STARTER_PROMPTS_FORK,
  };
  mocks.request.mockReset().mockImplementation(async ({ operation, text }) => ({
    text: operation === "cleanup" ? text.replace("use affect", "useEffect") : `Formatted: ${text}`,
  }));
  draft = { text: "", ownerKey: "a", revision: 0, selection: { start: 0, end: 0 } };
  input = {
    environmentId: EnvironmentId.make("test"),
    projectId: ProjectId.make("test"),
    threadId: null,
    ownerKey: "a",
    enabled: true,
    readDraft: () => ({ ...draft }),
    commitDraft: (text, cursor) => {
      draft.revision++;
      actions.markDraftChanged();
      draft = { ...draft, text, selection: { start: cursor, end: cursor } };
    },
  };
  screen = stack.use(await render(<Probe />, { router: false }));
  return stack.move();
}
describe("dictation text lifecycle", () => {
  it("cleans only the transcript, formats the committed draft, and undoes both to raw transcription", async () => {
    await using _fixture = await setup();
    let transcript = "";
    await act(async () => {
      transcript = await actions.processTranscript(
        "react use affect",
        new AbortController().signal,
      );
    });
    expect(transcript).toBe("react useEffect");
    await act(async () => {
      input.commitDraft(transcript, transcript.length);
      actions.transcriptionCommitted(transcript);
    });
    expect(mocks.request.mock.calls.map(([call]) => [call.operation, call.text])).toEqual([
      ["cleanup", "react use affect"],
      ["format", "react useEffect"],
    ]);
    expect(draft.text).toBe("Formatted: react useEffect");
    await click("Undo text processing");
    expect(draft.text).toBe("react use affect");
  });
  it("does not automatically process typed edits", async () => {
    await using _fixture = await setup();
    await act(async () => {
      draft.text = "typed use affect words";
      draft.revision++;
      actions.markDraftChanged();
      await screen.rerender(<Probe />);
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses the recording snapshot for Undo when editor and session revisions differ", async () => {
    await using _fixture = await setup();
    draft = { ...draft, text: "prefix suffix", revision: 8, selection: { start: 13, end: 13 } };
    let transcript = "";
    await act(async () => {
      transcript = await actions.processTranscript(
        "react use affect",
        new AbortController().signal,
        {
          ...draft,
          revision: 0,
          selection: { start: 7, end: 13 },
        },
      );
    });
    await act(async () => {
      const text = `prefix ${transcript}`;
      input.commitDraft(text, text.length);
      actions.transcriptionCommitted(text);
    });
    await click("Undo text processing");
    expect(draft.text).toBe("prefix react use affect");
  });
  it("ignores a manual result after the draft was edited and reverted", async () => {
    await using _fixture = await setup();
    const response = Promise.withResolvers<{ text: string }>();
    mocks.request.mockReturnValueOnce(response.promise);
    draft.text = "use affect";
    await click("Clean up draft");
    await act(() => {
      draft.revision += 2;
      actions.markDraftChanged();
    });
    await act(async () => {
      response.resolve({ text: "useEffect" });
      await response.promise;
    });
    expect(draft.text).toBe("use affect");
  });
  it("cancels cleanup without formatting or discarding the raw transcript", async () => {
    await using _fixture = await setup();
    mocks.request.mockImplementationOnce(
      (_input, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        ),
    );
    let pending: Promise<string>;
    await act(() => {
      pending = actions.processTranscript("react use affect", new AbortController().signal);
    });
    await click("Cancel text processing");
    await act(async () => {
      const text = await pending;
      input.commitDraft(text, text.length);
      actions.transcriptionCommitted(text);
    });
    expect(draft.text).toBe("react use affect");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { detail: "This model is unavailable.", label: "Clean up draft" },
    { detail: "Provider refused: Bearer [REDACTED] api_key=[REDACTED]", label: "Format draft" },
  ])("preserves the draft and shows provider detail for $label", async ({ detail, label }) => {
    await using _fixture = await setup();
    mocks.request.mockRejectedValueOnce({
      error: "Text generation failed.",
      code: "model",
      detail,
    });
    draft.text = "raw use affect";
    const original = structuredClone(draft);
    await click(label);
    expect(draft).toEqual(original);
    expect(errorText()).toContain(`${detail} Your draft was preserved.`);
  });
  it("keeps the current text when provider detail is absent", async () => {
    await using _fixture = await setup();
    mocks.request.mockRejectedValueOnce({ error: "Text generation failed.", code: "model" });
    draft.text = "raw use affect";
    await click("Clean up draft");
    expect(draft.text).toBe("raw use affect");
    expect(errorText()).toContain("Text processing failed. Your draft was preserved.");
  });
  it("preserves the transcript and shows detail on automatic cleanup failure", async () => {
    await using _fixture = await setup();
    mocks.request.mockRejectedValueOnce({
      error: "Text generation failed.",
      code: "model",
      detail: "This model is unavailable.",
    });
    await act(async () => {
      expect(await actions.processTranscript("raw use affect", new AbortController().signal)).toBe(
        "raw use affect",
      );
    });
    expect(errorText()).toContain(
      "This model is unavailable. The original transcript was preserved.",
    );
  });
  it("does not submit cleanup without operate permission or for empty speech", async () => {
    await using _fixture = await setup();
    mocks.canOperate = false;
    await screen.rerender(<Probe />);
    await act(async () => {
      expect(await actions.processTranscript("raw use affect", new AbortController().signal)).toBe(
        "raw use affect",
      );
    });
    mocks.canOperate = true;
    await screen.rerender(<Probe />);
    await act(async () => {
      expect(await actions.processTranscript(" ", new AbortController().signal)).toBe(" ");
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
