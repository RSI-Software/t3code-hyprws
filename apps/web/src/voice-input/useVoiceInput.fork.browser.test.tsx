import { act, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
} from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { DesktopVoiceSessionFork } from "./session.fork";
import { useDesktopVoiceInputFork } from "./useVoiceInput.fork";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  draft: "",
  listeners: new Set<() => void>(),
}));
const environmentId = EnvironmentId.make("test");
const prepared = { environmentId };
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => prepared) as never,
  usePreparedConnection: (() => Option.some(prepared)) as never,
  useEnvironmentScope: () => true,
}));
vi.mock(import("./useVoiceSettings.fork"), async (original) => ({
  ...(await original()),
  useVoiceTextSettingsFork: (() => ({
    settings: {
      projects: {},
      defaults: {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        cleanupMode: "auto",
        formattingMode: "auto",
        formattingMinWords: 2,
        recentMessageCount: 0,
        projectContext: "",
        ...VOICE_TEXT_STARTER_PROMPTS_FORK,
      },
    },
  })) as never,
}));
vi.mock(import("@t3tools/client-runtime/rpc"), async (original) => ({
  ...(await original()),
  readVoiceInputSettingsFork: (() => ({ settings: true })) as never,
  transformVoiceTextFork: ((_prepared: unknown, input: unknown) => input) as never,
}));
vi.mock("./client.fork", () => ({
  VOICE_SETTINGS_CHANGED_FORK: "settings-changed",
  runVoiceInputRequestFork: ((input: { settings?: boolean }, signal: AbortSignal) =>
    input.settings
      ? Promise.resolve({ provider: "local" })
      : mocks.request(input, signal)) as never,
}));
vi.mock("./settings.fork", () => ({
  voiceInputUnavailableReasonFork: () => null,
  voiceRecordingUnavailableReasonFork: () => null,
}));
vi.mock("./draft.fork", () => ({
  readVoiceDraftTextFork: () => mocks.draft,
  commitVoiceDraftFork: (_target: unknown, text: string) => {
    mocks.draft = text;
    mocks.listeners.forEach((listener) => listener());
  },
}));
let runtime: { session: DesktopVoiceSessionFork; recorder: { readLevel: () => number } };
vi.mock("./VoiceInputProvider.fork", () => ({
  useDesktopVoiceRuntimeFork: (() => ({
    ...runtime,
    snapshot: useSyncExternalStore(runtime.session.subscribe, runtime.session.getSnapshot),
  })) as never,
}));

let root: Root | undefined;
let actions: ReturnType<typeof useDesktopVoiceInputFork>;
function Probe() {
  const value = useDesktopVoiceInputFork({
    environmentId,
    projectId: ProjectId.make("test"),
    threadId: null,
    ownerKey: "draft",
    draftTarget: { environmentId, threadId: ThreadId.make("draft") },
    label: "Test draft",
    enabled: true,
    readSelection: () => ({ start: 0, end: 0 }),
    commitDraft: (text) => {
      mocks.draft = text;
      actions.markDraftChanged();
    },
  });
  useLayoutEffect(() => {
    actions = value;
  });
  // The composer hides the normal controls when the dictation toolbar is presented.
  return value.presented ? value.toolbar : value.controls;
}
let host: HTMLDivElement | undefined;
function container() {
  return host!;
}
function button(label: string) {
  const match = container().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!match) throw new Error(`No ${label} button.`);
  return match;
}
afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  runtime?.session.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.listeners.clear();
});

describe("automatic cleanup in the active dictation toolbar", () => {
  it.each(["button", "Escape"])(
    "cancels through %s and commits raw speech without formatting",
    async (cancelWith) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.draft = "";
      vi.spyOn(useComposerDraftStore, "subscribe").mockImplementation((listener) => {
        const notify = () =>
          listener(useComposerDraftStore.getState(), useComposerDraftStore.getState());
        mocks.listeners.add(notify);
        return () => mocks.listeners.delete(notify);
      });
      const recorded = Promise.withResolvers<void>();
      const cleanupStarted = Promise.withResolvers<AbortSignal>();
      const recorder = {
        uri: "memory:recording",
        prepareToRecordAsync: async () => {},
        record: () => recorded.resolve(),
        stop: async () => {},
        readLevel: () => 0,
      };
      runtime = {
        recorder,
        session: new DesktopVoiceSessionFork({
          recorder,
          requestPermission: async () => ({ granted: true, canAskAgain: true }),
          configureRecording: async () => {},
          releaseRecording: async () => {},
          deleteRecording: () => {},
          getTranscriber: () => ({
            prepare: async () => ({
              locale: "en-US",
              transcribe: async () => "raw use affect words",
            }),
          }),
        }),
      };
      mocks.request.mockReset().mockImplementation(
        (_input, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            cleanupStarted.resolve(signal);
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      );
      await act(() => {
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
        root.render(<Probe />);
      });
      await act(async () => {
        button("Record dictation").click();
        await recorded.promise;
      });
      let finishing: Promise<void>;
      await act(async () => {
        finishing = runtime.session.controller.stop();
        await cleanupStarted.promise;
      });
      expect(runtime.session.getSnapshot().state.phase).toBe("transcribing");
      expect(
        [...container().querySelectorAll('[role="status"]')].some((status) =>
          status.textContent?.includes("Cleaning up"),
        ),
      ).toBe(true);
      const cancelDictation = vi.spyOn(runtime.session.controller, "cancel");
      await act(async () => {
        if (cancelWith === "button") button("Cancel text processing").click();
        else
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
        await finishing;
      });
      expect(cancelDictation).not.toHaveBeenCalled();
      expect((await cleanupStarted.promise).aborted).toBe(true);
      expect(mocks.draft).toBe("raw use affect words");
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(runtime.session.getSnapshot().state.phase).toBe("idle");
    },
  );
});
