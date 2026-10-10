import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
  type VoiceTextConfigFork,
} from "@t3tools/contracts";
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
vi.mock("./client.fork", () => ({
  runVoiceInputRequestFork: (input: unknown, signal: AbortSignal) => mocks.request(input, signal),
}));
vi.mock("../components/ui/button", () => ({ Button: "button" }));
vi.mock("../components/ui/spinner", () => ({ Spinner: "span" }));
vi.mock("../components/ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: "span",
  TooltipPopup: "span",
}));

let renderer: ReactTestRenderer;
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
async function click(label: string) {
  await act(async () => {
    await renderer.root.findByProps({ "aria-label": label }).props.onClick();
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.canOperate = true;
  mocks.config = {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    cleanupMode: "auto",
    formattingMode: "auto",
    formattingMinWords: 2,
    recentMessageCount: 0,
    projectContext: "",
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
  await act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("dictation text lifecycle", () => {
  it("cleans only the transcript, formats the committed draft, and undoes both to raw transcription", async () => {
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
    await act(() => {
      draft.text = "typed use affect words";
      draft.revision++;
      actions.markDraftChanged();
      renderer.update(<Probe />);
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses the recording snapshot for Undo when editor and session revisions differ", async () => {
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
  it("preserves the transcript on cleanup failure", async () => {
    mocks.request.mockRejectedValueOnce(new Error("model failed"));
    await act(async () => {
      expect(await actions.processTranscript("raw use affect", new AbortController().signal)).toBe(
        "raw use affect",
      );
    });
  });
  it("does not submit cleanup without operate permission or for empty speech", async () => {
    mocks.canOperate = false;
    await act(() => renderer.update(<Probe />));
    await act(async () => {
      expect(await actions.processTranscript("raw use affect", new AbortController().signal)).toBe(
        "raw use affect",
      );
    });
    mocks.canOperate = true;
    await act(() => renderer.update(<Probe />));
    await act(async () => {
      expect(await actions.processTranscript(" ", new AbortController().signal)).toBe(" ");
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
