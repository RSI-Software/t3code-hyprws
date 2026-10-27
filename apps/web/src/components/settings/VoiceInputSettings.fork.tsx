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
import { useVoiceSettingsFork } from "../../voice-input/useVoiceSettings.fork";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SERVICES_FORK = [
  {
    provider: "openai-compatible",
    label: "OpenAI-compatible",
    defaults: { provider: "openai-compatible", baseUrl: "", live: false, model: "" },
  },
  {
    provider: "meta",
    label: "Meta",
    defaults: {
      provider: "meta",
      baseUrl: "https://api.meta.ai/v1",
      live: true,
      model: "muse-voice-transcribe-1.0",
    },
  },
] as const;

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
          baseUrl: settings.baseUrl,
          live: settings.live,
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
        baseUrl: saved.baseUrl,
        live: saved.live,
        model: saved.model,
      });
      window.dispatchEvent(new Event(VOICE_SETTINGS_CHANGED_FORK));
      setMessage("Dictation settings saved.");
    } catch {
      setMessage("Could not save. Check the base URL, model, and environment permissions.");
    }
    setSaving(false);
  };
  const hasSavedKey =
    settings?.hasApiKey &&
    form?.provider === settings.provider &&
    form?.baseUrl === settings.baseUrl;
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
              description="Audio is sent through this environment to the service below."
            >
              <div className="grid gap-3 py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="dictation-service-fork">Service</Label>
                    <Select
                      value={form.provider}
                      onValueChange={(value) => {
                        const service = SERVICES_FORK.find((s) => s.provider === value);
                        if (service) update({ ...service.defaults, apiKey: "" });
                      }}
                    >
                      <SelectTrigger
                        id="dictation-service-fork"
                        size="sm"
                        aria-label="Dictation speech service"
                      >
                        <SelectValue>
                          {SERVICES_FORK.find((s) => s.provider === form.provider)?.label}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {SERVICES_FORK.map((service) => (
                          <SelectItem key={service.provider} value={service.provider}>
                            {service.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
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
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="dictation-base-url-fork">Base URL</Label>
                  <Input
                    id="dictation-base-url-fork"
                    size="sm"
                    aria-label="Dictation base URL"
                    autoComplete="off"
                    placeholder="https://api.openai.com/v1"
                    value={form.baseUrl}
                    onChange={(event) => update({ baseUrl: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {form.provider === "meta"
                      ? "Meta's API root; T3 adds /asr/transcribe and /asr/realtime."
                      : "The API root; T3 adds /audio/transcriptions and /realtime."}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div className="grid gap-0.5">
                    <Label htmlFor="dictation-live-fork">Live preview</Label>
                    <p className="text-xs text-muted-foreground">
                      Show words while you speak. Needs a realtime endpoint; off transcribes after
                      Stop.
                    </p>
                  </div>
                  <Switch
                    id="dictation-live-fork"
                    aria-label="Dictation live preview"
                    checked={form.live}
                    onCheckedChange={(live) => update({ live })}
                  />
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
