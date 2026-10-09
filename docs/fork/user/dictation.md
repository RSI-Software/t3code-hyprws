# Desktop dictation

Open **Settings > Dictation** and select an environment.
Choose your microphone; allow microphone access to show device names.
Enable **Speaker ducking** to lower selected outputs while recording (Linux with PipeWire or PulseAudio).
Check one or more outputs; **System default** selects the default at recording start.
**Target volume** is a percentage of each output’s starting volume; set separate fade-down and fade-back-up times in milliseconds (`0` is instant, `1000` is one second).
These preferences save automatically on this desktop.
Stop, cancel, or closing the recording window restores volume; manual volume adjustments and mute state are preserved.
Choose a speech service, enter its endpoint and API key if required, enable dictation, then save.

In chat, click the mic, speak, then click the check to finish.
Review or edit the transcript before sending.
Click X or press Escape to cancel.

After finishing recording, you can switch threads or open Settings while transcription continues.
The text returns to the original draft; the background control lets you return or cancel.
If that draft changes, use **Copy transcript** to recover the text.
Leaving the chat while the microphone is still recording cancels dictation.

**Meta Muse:** use the default endpoint and model with your Meta API key.
Words appear while you speak; the check commits the final transcript.
The mic stays disabled until the saved speech configuration is complete.
**Local HTTP:** your side app receives a raw `audio/wav` POST and returns `{"text":"words"}`.
**OpenAI-compatible / custom:** use any compatible transcription endpoint and model.
Other listed services are unavailable until their adapters are implemented.

Endpoints resolve from the selected environment's server: `localhost` means that server's machine.
Audio stays in memory and is limited to five minutes.
Meta streams audio while recording; other services upload when recording finishes.
Keys are stored on that environment; changing the service or endpoint clears a saved key.
