// Fork-owned search entries for Settings → Voice (voice-input), spread into upstream's
// `SETTINGS_SEARCH_ITEMS` through one marked hook. Typed structurally (`as const`) so this module
// stays import-cycle-free when `settingsSearch.ts` evaluates first.
export const voiceSearchItemsFork = [
  {
    // The custom service is a choice under upstream's Transcribe with row.
    id: "voice-custom-transcription",
    targetId: "voice-transcription-destination",
    title: "Custom transcription service",
    to: "/settings/voice",
    searchTerms: ["remote openai-compatible speech model server endpoint url api key self-hosted"],
  },
  {
    id: "voice-ducking",
    title: "Duck speaker output",
    to: "/settings/voice",
    desktopOnly: true,
    searchTerms: ["speaker ducking lower volume music audio while recording dictation fade"],
  },
  {
    id: "voice-ducking-outputs",
    title: "Ducking output devices",
    to: "/settings/voice",
    desktopOnly: true,
    searchTerms: ["speaker ducking audio outputs headphones default"],
  },
] as const;
