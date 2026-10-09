# Desktop dictation

Open **Settings > Dictation** and select an environment.
Choose your microphone; allow microphone access to show device names.
Choose a speech service, enter its endpoint and API key if required, enable dictation, then save.

In chat, click the mic, speak, then click the check to finish.
Review or edit the transcript before sending.
Click X or press Escape to cancel.

**Meta Muse:** use the default endpoint and model with your Meta API key.
The mic stays disabled until the saved speech configuration is complete.
**Local HTTP:** your side app receives a raw `audio/wav` POST and returns `{"text":"words"}`.
**OpenAI-compatible / custom:** use any compatible transcription endpoint and model.
Other listed services are unavailable until their adapters are implemented.

Endpoints resolve from the selected environment's server: `localhost` means that server's machine.
Audio stays in memory, is limited to five minutes, and is uploaded when recording finishes.
Keys are stored on that environment; changing the service or endpoint clears a saved key.
