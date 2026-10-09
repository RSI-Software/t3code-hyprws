import { saveVoiceInputSettingsFork } from "@t3tools/client-runtime/rpc";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type VoiceInputConfigUpdateFork,
} from "@t3tools/contracts";
import { useState } from "react";
import { XIcon } from "lucide-react";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import {
  runVoiceInputRequestFork,
  VOICE_SETTINGS_CHANGED_FORK,
} from "../../voice-input/client.fork";
import { useVoiceSettingsFork } from "../../voice-input/useVoiceInput.fork";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function VoiceInputSettingsFork({ environmentId }: { environmentId: EnvironmentId | null }) {
  const { settings, error: loadError } = useVoiceSettingsFork(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [editedForm, setForm] = useState<VoiceInputConfigUpdateFork | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const form =
    editedForm ??
    (settings
      ? {
          enabled: settings.enabled,
          provider: settings.provider,
          endpoint: settings.endpoint,
          model: settings.model,
        }
      : null);
  const update = (patch: Partial<VoiceInputConfigUpdateFork>) => {
    setForm(form ? { ...form, ...patch } : null);
    setMessage(null);
  };
  const save = async () => {
    if (!environmentId || !form || !canWrite || saving) return;
    const prepared = readPreparedConnection(environmentId);
    if (!prepared) {
      setMessage("Environment is disconnected.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const saved = await runVoiceInputRequestFork(saveVoiceInputSettingsFork(prepared, form));
      setForm({
        enabled: saved.enabled,
        provider: saved.provider,
        endpoint: saved.endpoint,
        model: saved.model,
      });
      window.dispatchEvent(new Event(VOICE_SETTINGS_CHANGED_FORK));
      setMessage("Dictation settings saved.");
    } catch {
      setMessage("Could not save. Check the endpoint and environment permissions.");
    }
    setSaving(false);
  };
  const hasSavedKey =
    settings?.hasApiKey &&
    form?.provider === settings.provider &&
    form?.endpoint === settings.endpoint;
  return (
    <SettingsSection id="voice-input-fork" title="Transcription">
      {!environmentId ? (
        <p className="text-sm text-muted-foreground">
          Select one environment to configure transcription.
        </p>
      ) : !form || !settings ? (
        <p role="status" className="text-sm text-muted-foreground">
          {loadError ?? "Loading dictation settings…"}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={!canWrite || saving} className="min-w-0">
            <SettingsRow
              title="Enable dictation"
              description="Record, stop, then review the transcript before sending."
              control={
                <Switch
                  aria-label="Enable dictation"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => update({ enabled })}
                />
              }
            />
            <SettingsRow
              title="Speech service"
              description="Audio is sent through this environment to the endpoint below."
            >
              <div className="grid gap-3 py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="dictation-service-fork">Service</Label>
                    <Select
                      value={form.provider}
                      onValueChange={(value) => {
                        const provider = settings.providers.find((p) => p.id === value);
                        if (provider?.available)
                          update({
                            provider: provider.id,
                            endpoint: provider.endpoint,
                            model: provider.model,
                            apiKey: "",
                          });
                      }}
                    >
                      <SelectTrigger
                        id="dictation-service-fork"
                        size="sm"
                        aria-label="Dictation speech service"
                      >
                        <SelectValue>
                          {settings.providers.find((p) => p.id === form.provider)?.label}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {settings.providers.map((provider) => (
                          <SelectItem
                            key={provider.id}
                            value={provider.id}
                            disabled={!provider.available}
                          >
                            {provider.label}
                            {provider.available ? "" : " (coming later)"}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  {form.provider !== "local" ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor="dictation-model-fork">Model</Label>
                      <Input
                        id="dictation-model-fork"
                        size="sm"
                        aria-label="Dictation model"
                        autoComplete="off"
                        value={form.model}
                        onChange={(event) => update({ model: event.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="dictation-endpoint-fork">Endpoint</Label>
                  <Input
                    id="dictation-endpoint-fork"
                    size="sm"
                    aria-label="Dictation endpoint"
                    autoComplete="off"
                    placeholder={
                      form.provider === "local"
                        ? "http://localhost:8000/transcribe"
                        : "https://your-service/v1/audio/transcriptions"
                    }
                    value={form.endpoint}
                    onChange={(event) => update({ endpoint: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {form.provider === "local"
                      ? "Full transcription URL. Accepts WAV audio and returns text in JSON."
                      : "Full transcription URL, including the transcription path."}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="dictation-key-fork">
                    API key{form.provider === "meta" ? "" : " (optional)"}
                  </Label>
                  <InputGroup>
                    <InputGroupInput
                      id="dictation-key-fork"
                      type="password"
                      size="sm"
                      autoComplete="off"
                      aria-label="Dictation API key"
                      placeholder={
                        hasSavedKey && form.apiKey === undefined ? "••••••••••••••••" : "Not set"
                      }
                      value={form.apiKey ?? ""}
                      onChange={(event) => update({ apiKey: event.target.value })}
                    />
                    {(hasSavedKey && form.apiKey === undefined) || form.apiKey ? (
                      <InputGroupAddon align="inline-end">
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Remove dictation API key"
                          title="Remove API key"
                          onClick={() => update({ apiKey: "" })}
                        >
                          <XIcon />
                        </Button>
                      </InputGroupAddon>
                    ) : null}
                  </InputGroup>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <p role="status" className="text-xs text-muted-foreground">
                    {message}
                  </p>
                  <Button type="submit" size="xs" disabled={saving || !canWrite}>
                    {saving ? "Saving…" : "Save dictation"}
                  </Button>
                </div>
              </div>
            </SettingsRow>
          </fieldset>
        </form>
      )}
    </SettingsSection>
  );
}
