import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { readSpeechRemoteModelFork, saveSpeechRemoteModelFork } from "@t3tools/client-runtime/rpc";
import type {
  SpeechRemoteModelSettingsFork,
  SpeechRemoteModelUpdateFork,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { VoiceDuckingSettingsFork } from "./VoiceDuckingSettings.fork";

type Run = (label: string, work: () => Promise<unknown>) => Promise<void>;

/** Fork sections on Settings → Voice: the remote model and desktop speaker ducking. */
export function VoiceSettingsFork(props: { prepared: PreparedConnection | null; run: Run }) {
  return (
    <>
      {props.prepared ? (
        <RemoteSpeechModelSettings
          key={props.prepared.environmentId}
          prepared={props.prepared}
          run={props.run}
        />
      ) : null}
      {window.desktopBridge ? <VoiceDuckingSettingsFork /> : null}
    </>
  );
}

function RemoteSpeechModelSettings({ prepared, run }: { prepared: PreparedConnection; run: Run }) {
  const [saved, setSaved] = useState<SpeechRemoteModelSettingsFork | null>(null);
  const [edited, setEdited] = useState<SpeechRemoteModelUpdateFork | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's saved remote model once its connection is ready
  useEffect(() => {
    let current = true;
    runEnvironmentSpeech(readSpeechRemoteModelFork(prepared)).then(
      (settings) => current && setSaved(settings),
      () => current && setLoadFailed(true),
    );
    return () => {
      current = false;
    };
  }, [prepared]);
  const form =
    edited ?? (saved && { baseUrl: saved.baseUrl, model: saved.model, live: saved.live });
  if (!form)
    return loadFailed ? (
      <SettingsSection id="voice-remote-model-fork" title="Remote model">
        <SettingsRow
          title="OpenAI-compatible service"
          description="Could not load the remote model settings."
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setLoadFailed(false);
                runEnvironmentSpeech(readSpeechRemoteModelFork(prepared)).then(setSaved, () =>
                  setLoadFailed(true),
                );
              }}
            >
              Retry
            </Button>
          }
        />
      </SettingsSection>
    ) : null;
  const update = (patch: Partial<SpeechRemoteModelUpdateFork>) => setEdited({ ...form, ...patch });
  const keyKept = saved?.hasApiKey && form.apiKey === undefined && form.baseUrl === saved.baseUrl;
  const save = () =>
    run("Could not save the remote model", async () => {
      setSaved(await runEnvironmentSpeech(saveSpeechRemoteModelFork(prepared, form)));
      setEdited(null);
    });
  return (
    <SettingsSection id="voice-remote-model-fork" title="Remote model">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <SettingsRow
          title="OpenAI-compatible service"
          description="Adds a model under Transcription. This environment forwards recordings to the service; select the model there to use it."
        >
          <div className="grid gap-2 py-3 sm:grid-cols-2">
            <Input
              size="sm"
              aria-label="Remote model base URL"
              autoComplete="off"
              placeholder="https://api.openai.com/v1"
              value={form.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
            <Input
              size="sm"
              aria-label="Remote model name"
              autoComplete="off"
              placeholder="Model"
              value={form.model}
              onChange={(event) => update({ model: event.target.value })}
            />
            <Input
              size="sm"
              type="password"
              aria-label="Remote model API key"
              autoComplete="off"
              placeholder={keyKept ? "Saved key" : "API key (optional)"}
              value={form.apiKey ?? ""}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label="Remote model live preview"
                  checked={form.live}
                  onCheckedChange={(live) => update({ live })}
                />
                Live preview
              </label>
              <Button type="submit" size="xs" disabled={!edited}>
                Save
              </Button>
            </div>
          </div>
        </SettingsRow>
      </form>
    </SettingsSection>
  );
}
