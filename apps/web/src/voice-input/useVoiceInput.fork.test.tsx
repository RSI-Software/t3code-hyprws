import { act, useLayoutEffect, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
} from "@t3tools/contracts";
import { DesktopVoiceSessionFork } from "./session.fork";
import { useDesktopVoiceInputFork } from "./useVoiceInput.fork";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  draft: "",
  listeners: new Set<() => void>(),
}));
const environmentId = EnvironmentId.make("test");
const prepared = { environmentId };
vi.mock("../state/session", () => ({
  readPreparedConnection: () => prepared,
  usePreparedConnection: () => Option.some(prepared),
  useEnvironmentScope: () => true,
}));
vi.mock("./useVoiceSettings.fork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useVoiceSettings.fork")>()),
  useVoiceTextSettingsFork: () => ({
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
  }),
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({
  readVoiceInputSettingsFork: () => ({ settings: true }),
  transformVoiceTextFork: (_prepared: unknown, input: unknown) => input,
}));
vi.mock("./client.fork", () => ({
  VOICE_SETTINGS_CHANGED_FORK: "settings-changed",
  runVoiceInputRequestFork: (input: { settings?: boolean }, signal: AbortSignal) =>
    input.settings ? Promise.resolve({ provider: "local" }) : mocks.request(input, signal),
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
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
let runtime: { session: DesktopVoiceSessionFork; recorder: { readLevel: () => number } };
vi.mock("./VoiceInputProvider.fork", () => ({
  useDesktopVoiceRuntimeFork: () => ({
    ...runtime,
    snapshot: useSyncExternalStore(runtime.session.subscribe, runtime.session.getSnapshot),
  }),
}));
vi.mock("../components/ui/button", () => ({ Button: "button" }));
vi.mock("../components/ui/spinner", () => ({ Spinner: "span" }));
vi.mock("../components/ui/tooltip", () => ({
  Tooltip: "div",
  TooltipTrigger: "span",
  TooltipPopup: "span",
}));

let renderer: ReactTestRenderer | undefined;
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
afterEach(async () => {
  await act(() => renderer?.unmount());
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
      const documentEvents = new EventTarget();
      vi.stubGlobal("document", {
        addEventListener: (type: string, listener: EventListener) =>
          documentEvents.addEventListener(type, listener),
        removeEventListener: (type: string, listener: EventListener) =>
          documentEvents.removeEventListener(type, listener),
      });
      vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval, clearInterval }));
      vi.stubGlobal("navigator", { language: "en-US" });
      mocks.draft = "";
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
        renderer = create(<Probe />);
      });
      await act(async () => {
        renderer!.root.findByProps({ "aria-label": "Record dictation" }).props.onClick();
        await recorded.promise;
      });
      let finishing: Promise<void>;
      await act(async () => {
        finishing = runtime.session.controller.stop();
        await cleanupStarted.promise;
      });
      expect(runtime.session.getSnapshot().state.phase).toBe("transcribing");
      expect(
        renderer!.root
          .findAllByProps({ role: "status" })
          .some((status) => status.children.includes("Cleaning up")),
      ).toBe(true);
      const cancelDictation = vi.spyOn(runtime.session.controller, "cancel");
      await act(async () => {
        if (cancelWith === "button")
          renderer!.root.findByProps({ "aria-label": "Cancel text processing" }).props.onClick();
        else {
          const event = new Event("keydown", { cancelable: true });
          Object.defineProperty(event, "key", { value: "Escape" });
          documentEvents.dispatchEvent(event);
        }
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
