import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const voiceInputMacPurposeFork = Object.freeze({
  NSMicrophoneUsageDescription: "T3 Code records speech when you start dictation.",
});

/** The custom passkey plist replaces Electron's default hardened entitlements. */
export const enableVoiceInputMacEntitlementsFork = Effect.fn(function* (
  fs: FileSystem.FileSystem,
  path: string,
) {
  const plist = yield* fs.readFileString(path);
  yield* fs.writeFileString(
    path,
    plist.replace(
      "</dict>",
      "  <key>com.apple.security.device.audio-input</key>\n    <true/>\n  </dict>",
    ),
  );
});
