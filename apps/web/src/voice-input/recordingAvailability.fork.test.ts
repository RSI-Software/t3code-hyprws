import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { voiceRecordingUnavailableReasonFork } from "./settings.fork";

afterEach(() => vi.unstubAllGlobals());

describe("dictation recording availability", () => {
  it("allows recording in a capable browser without a desktop bridge", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal("MediaRecorder", class {});
    expect(voiceRecordingUnavailableReasonFork()).toBeNull();
  });

  it("explains why an insecure remote origin cannot record", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    expect(voiceRecordingUnavailableReasonFork()).toContain("HTTPS");
  });

  it("handles clients without microphone or recording APIs", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {});
    expect(voiceRecordingUnavailableReasonFork()).toContain("does not support");
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal("MediaRecorder", undefined);
    expect(voiceRecordingUnavailableReasonFork()).toContain("does not support");
  });
});
