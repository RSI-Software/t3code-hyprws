# Dictation

Speak into the composer with a speech service you choose.
Recording works in the desktop app and in browsers on HTTPS or localhost.

## Set up

1. Open **Settings → Dictation**, pick an environment
2. Choose your microphone
3. Pick a speech service, base URL, and model
4. Enter an API key if the service needs one
5. Enable dictation and save

Services:

- **Meta** needs only your Meta API key
- **OpenAI-compatible** fits OpenAI transcription APIs

The base URL resolves on that environment's server, so `localhost` means that machine.
Changing the service or base URL **clears the saved key**.

## Dictate

1. Click the mic and speak
2. Click the check to finish; X or Escape cancels
3. Review the transcript, then send

Recordings are **capped at five minutes**.
After finishing, you can switch threads while transcription continues; the text returns to the original draft.
If that draft changed meanwhile, use **Copy transcript**.

**Live preview** shows words as you speak; turn it off for services without OpenAI Realtime transcription.

## Speech terms

List names the service should recognize under **Speech terms**, one per line, per project.
Add `heard, misheard -> Term` to **fix a spelling** in every transcript.
Meta **ignores terms**, and terms over four words are left out.

## Cleanup and formatting

Set each to **Off**, **Manual**, or **Automatic**, and choose the model that runs them.

- **Cleanup** uses the selection or draft
- **Formatting** uses the whole draft
- **Automatic** runs only after dictation
- **Undo** restores the text before processing

Select a project to customize its prompts, and use **Generate / Refresh context** to pull vocabulary from the project; review it before saving.

## Speaker ducking

On the Linux desktop, **Speaker ducking** lowers chosen outputs while you record (PipeWire or PulseAudio).
**Target volume** is a share of each output's starting volume.
Stopping or cancelling restores the volume.
