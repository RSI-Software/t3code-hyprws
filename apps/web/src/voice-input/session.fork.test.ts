import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DesktopVoiceSessionFork, type DesktopVoiceTargetFork } from "./session.fork";

function createDraft(ownerKey: string, environmentId = EnvironmentId.make("first-environment")) {
  let text: string | null = "hello world";
  const listeners = new Set<() => void>();
  const commit = vi.fn((next: string) => {
    text = next;
  });
  const target: DesktopVoiceTargetFork = {
    ownerKey,
    environmentId,
    label: ownerKey,
    route: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(ownerKey)) },
    readDraft: () =>
      text === null
        ? null
        : {
            ownerKey,
            text,
            selection: { start: 6, end: 11 },
          },
    commitDraft: commit,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    target,
    commit,
    read: () => text,
    listeners,
    change: (next: string | null) => {
      text = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function createSession() {
  const result = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<AbortSignal>();
  const getTranscriber = vi.fn((_target: DesktopVoiceTargetFork) => ({
    prepare: async () => ({
      locale: "en-US",
      transcribe: async (_uri: string, { signal }: { signal: AbortSignal }) => {
        entered.resolve(signal);
        return result.promise;
      },
    }),
  }));
  const recorder = {
    uri: "memory:recording",
    prepareToRecordAsync: vi.fn(async () => {}),
    record: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const deleteRecording = vi.fn();
  const session = new DesktopVoiceSessionFork({
    recorder,
    getTranscriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording,
  });
  return { session, result, entered, recorder, deleteRecording, getTranscriber };
}

describe("desktop dictation across navigation", () => {
  it("replaces live hypotheses without changing the draft and commits the final once", async () => {
    const { session, result, entered } = createSession();
    const original = createDraft("original");
    await session.start(original.target);
    session.previewTranscript("spoken", "en-US");
    session.previewTranscript("spoken text", "en-US");
    expect(session.getSnapshot().preview?.text).toBe("spoken text");
    expect(original.read()).toBe("hello world");
    expect(original.commit).not.toHaveBeenCalled();
    const finishing = session.controller.stop();
    await entered.promise;
    result.resolve("Final words.");
    await finishing;
    expect(original.commit).toHaveBeenCalledOnce();
    expect(original.read()).toBe("hello Final words.");
    expect(session.getSnapshot().preview).toBeNull();
  });

  it.each(["edited", "edited and undone"])(
    "clears and refuses live preview when %s",
    async (change) => {
      const { session } = createSession();
      const original = createDraft("original");
      await session.start(original.target);
      session.previewTranscript("spoken", "en-US");
      expect(session.getSnapshot().preview).not.toBeNull();
      original.change("changed draft");
      expect(session.getSnapshot().preview).toBeNull();
      if (change === "edited and undone") original.change("hello world");
      session.previewTranscript("late words", "en-US");
      expect(session.getSnapshot().preview).toBeNull();
      session.controller.cancel();
    },
  );

  it("clears live preview when leaving a recording and ignores late words", async () => {
    const { session } = createSession();
    const original = createDraft("original");
    const detach = session.attach("original", vi.fn());
    await session.start(original.target);
    session.previewTranscript("spoken", "en-US");
    detach();
    session.previewTranscript("late words", "en-US");
    expect(session.getSnapshot().preview).toBeNull();
    expect(original.read()).toBe("hello world");
    expect(original.commit).not.toHaveBeenCalled();
  });

  it.each(["existing thread", "new thread", "settings"])(
    "finishes in the original draft after navigating to %s",
    async (destination) => {
      const { session, result, entered, deleteRecording } = createSession();
      const original = createDraft("original");
      const originalEditor = vi.fn();
      const detach = session.attach("original", originalEditor);
      await session.start(original.target);
      const finishing = session.controller.stop();
      const signal = await entered.promise;
      detach();
      const otherEditor = vi.fn();
      if (destination !== "settings") session.attach(destination, otherEditor);

      expect(signal.aborted).toBe(false);
      expect(session.getSnapshot().state.phase).toBe("transcribing");
      result.resolve("spoken text");
      await finishing;

      expect(original.read()).toBe("hello spoken text");
      expect(original.commit).toHaveBeenCalledWith("hello spoken text", { start: 17, end: 17 });
      expect(originalEditor).not.toHaveBeenCalled();
      expect(otherEditor).not.toHaveBeenCalled();
      expect(session.getSnapshot().state.phase).toBe("idle");
      expect(original.listeners.size).toBe(0);
      expect(deleteRecording).toHaveBeenCalledWith("memory:recording");
    },
  );

  it("restores the cursor only if the original composer is visible again", async () => {
    const { session, result, entered } = createSession();
    const original = createDraft("original");
    const detach = session.attach("original", vi.fn());
    await session.start(original.target);
    const finishing = session.controller.stop();
    await entered.promise;
    detach();
    const editor = vi.fn();
    session.attach("original", editor);
    result.resolve("spoken text");
    await finishing;
    expect(editor).toHaveBeenCalledWith("hello spoken text", { start: 17, end: 17 });
  });

  it("keeps the original environment and prevents retargeting an in-flight transcription", async () => {
    const { session, result, entered, getTranscriber } = createSession();
    const original = createDraft("original");
    const other = createDraft("other", EnvironmentId.make("second-environment"));
    await session.start(original.target);
    const finishing = session.controller.stop();
    await entered.promise;
    await session.start(other.target);
    result.resolve("spoken text");
    await finishing;
    expect(getTranscriber).toHaveBeenCalledExactlyOnceWith(original.target);
    expect(other.commit).not.toHaveBeenCalled();
    expect(session.getSnapshot().target).toBe(original.target);
  });

  it.each(["edited", "edited and undone", "deleted"])(
    "preserves the transcript for copying if the original draft was %s off screen",
    async (change) => {
      const { session, result, entered } = createSession();
      const original = createDraft("original");
      await session.start(original.target);
      const finishing = session.controller.stop();
      await entered.promise;
      original.change(change === "deleted" ? null : "changed draft");
      if (change === "edited and undone") original.change("hello world");
      result.resolve("spoken text");
      await finishing;
      expect(original.commit).not.toHaveBeenCalled();
      expect(session.getSnapshot().state.error).toContain("draft changed");
      expect(session.getSnapshot().transcript).toBe("spoken text");
      expect(original.listeners.size).toBe(0);
      session.controller.cancel();
      expect(session.getSnapshot().transcript).toBeNull();
    },
  );

  it("does not count edits to another composer as edits to the destination", async () => {
    const { session, result, entered } = createSession();
    const original = createDraft("original");
    await session.start(original.target);
    const finishing = session.controller.stop();
    await entered.promise;
    session.markDraftChanged("other");
    result.resolve("spoken text");
    await finishing;
    expect(original.read()).toBe("hello spoken text");
  });

  it.each(["cancel", "dispose"] as const)(
    "%s still aborts off-screen transcription",
    async (action) => {
      const { session, result, entered } = createSession();
      const original = createDraft("original");
      await session.start(original.target);
      const finishing = session.controller.stop();
      const signal = await entered.promise;
      if (action === "cancel") session.controller.cancel();
      else session.dispose();
      expect(signal.aborted).toBe(true);
      result.resolve("late text");
      await finishing;
      expect(original.commit).not.toHaveBeenCalled();
      expect(session.getSnapshot().transcript).toBeNull();
      expect(original.listeners.size).toBe(0);
    },
  );

  it("continues transcription when the window becomes hidden", async () => {
    const { session, result, entered } = createSession();
    const original = createDraft("original");
    await session.start(original.target);
    const finishing = session.controller.stop();
    const signal = await entered.promise;
    await session.controller.appMovedToBackground();
    expect(signal.aborted).toBe(false);
    result.resolve("spoken text");
    await finishing;
    expect(original.read()).toBe("hello spoken text");
  });

  it("stops the microphone when its composer is left during recording", async () => {
    const { session, recorder } = createSession();
    const original = createDraft("original");
    const detach = session.attach("original", vi.fn());
    await session.start(original.target);
    detach();
    expect(session.getSnapshot().state.phase).toBe("idle");
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(original.commit).not.toHaveBeenCalled();
  });
});
