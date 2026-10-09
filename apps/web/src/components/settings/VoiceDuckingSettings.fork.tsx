import {
  VOICE_DUCKING_DEFAULT_OUTPUT_FORK,
  type VoiceDuckingOutputsFork,
  type VoiceDuckingSettingsFork as DuckingSettings,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  readVoiceDuckingFork,
  saveVoiceDuckingFork,
  VOICE_DUCKING_CHANGED_FORK,
} from "../../voice-input/ducking.fork";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

async function listSpeakerOutputs(): Promise<VoiceDuckingOutputsFork> {
  const bridge = window.desktopBridge?.voiceDuckingFork;
  if (!bridge) {
    return { unavailableReason: "Speaker ducking requires a newer desktop build.", outputs: [] };
  }
  try {
    return await bridge.listOutputs();
  } catch {
    return { unavailableReason: "Could not list speaker outputs. Try refreshing.", outputs: [] };
  }
}

export function VoiceDuckingSettingsFork() {
  const [settings, setSettings] = useState(readVoiceDuckingFork);
  const [devices, setDevices] = useState<VoiceDuckingOutputsFork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const refresh = useCallback(async () => {
    setDevices(await listSpeakerOutputs());
    setRefreshing(false);
  }, []);
  useEffect(() => {
    void refresh();
    const reload = () => setSettings(readVoiceDuckingFork());
    const focus = () => {
      reload();
      void refresh();
    };
    window.addEventListener("storage", reload);
    window.addEventListener(VOICE_DUCKING_CHANGED_FORK, reload);
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener(VOICE_DUCKING_CHANGED_FORK, reload);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  const update = (patch: Partial<DuckingSettings>) => {
    try {
      const next = { ...settings, ...patch };
      saveVoiceDuckingFork(next);
      setSettings(next);
      setError(null);
    } catch {
      setError("Could not save speaker ducking settings.");
    }
  };
  const toggleOutput = (id: string, checked: boolean) =>
    update({
      outputIds: checked
        ? [...new Set([...settings.outputIds, id])]
        : settings.outputIds.filter((selected) => selected !== id),
    });
  const outputs = devices?.outputs ?? [];
  const defaultLabel = outputs.find((output) => output.isDefault)?.label;
  const outputIds = new Set(outputs.map((output) => output.id));
  const selectedIds = new Set(settings.outputIds);
  const missing = settings.outputIds.filter(
    (id) => id !== VOICE_DUCKING_DEFAULT_OUTPUT_FORK && !outputIds.has(id),
  );
  const unavailable = !devices || devices.unavailableReason !== null;
  return (
    <SettingsSection id="voice-ducking-fork" title="Speaker ducking">
      <SettingsRow
        title="Duck speaker output"
        description="Lower selected outputs while recording. Saved on this desktop; changes apply to the next recording."
        control={
          <Switch
            aria-label="Duck speaker output"
            checked={settings.enabled}
            disabled={unavailable && !settings.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        }
      />
      <SettingsRow
        title="Output devices"
        description="Select one or more. System default is resolved when recording starts."
      >
        <div className="grid gap-2 py-3">
          <label className="flex min-h-9 items-center gap-3 text-sm">
            <Checkbox
              checked={selectedIds.has(VOICE_DUCKING_DEFAULT_OUTPUT_FORK)}
              disabled={unavailable}
              onCheckedChange={(checked) =>
                toggleOutput(VOICE_DUCKING_DEFAULT_OUTPUT_FORK, checked)
              }
            />
            <span>
              System default
              {defaultLabel ? ` (${defaultLabel})` : ""}
            </span>
          </label>
          {outputs.map((output) => (
            <label key={output.id} className="flex min-h-9 items-center gap-3 text-sm">
              <Checkbox
                checked={selectedIds.has(output.id)}
                onCheckedChange={(checked) => toggleOutput(output.id, checked)}
              />
              <span>{output.label}</span>
            </label>
          ))}
          {missing.map((id) => (
            <label
              key={id}
              className="flex min-h-9 items-center gap-3 text-sm text-muted-foreground"
            >
              <Checkbox checked onCheckedChange={(checked) => toggleOutput(id, checked)} />
              <span className="min-w-0 break-all">{id} (unavailable)</span>
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="xs"
              variant="outline"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void refresh();
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh outputs"}
            </Button>
            <p role="status" className="text-xs text-muted-foreground">
              {devices?.unavailableReason ?? (!devices ? "Loading outputs…" : null)}
            </p>
          </div>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Target volume (%)"
        description="Percentage of each output’s starting volume. 0% silences it; 100% leaves it unchanged."
        control={
          <div className="w-28">
            <Input
              type="number"
              size="sm"
              aria-label="Ducking target volume (%)"
              min={0}
              max={100}
              step={1}
              value={settings.targetPercent}
              onChange={(event) => {
                if (event.target.value !== "" && event.target.validity.valid)
                  update({ targetPercent: Number(event.target.value) });
              }}
            />
          </div>
        }
      />
      <SettingsRow
        title="Fade down (ms)"
        description="How quickly output drops when recording starts. 0 is instant."
        control={
          <div className="w-28">
            <Input
              type="number"
              size="sm"
              aria-label="Fade down (ms)"
              min={0}
              max={10000}
              step={1}
              value={settings.fadeDownMs}
              onChange={(event) => {
                if (event.target.value !== "" && event.target.validity.valid)
                  update({ fadeDownMs: Number(event.target.value) });
              }}
            />
          </div>
        }
      />
      <SettingsRow
        title="Fade back up (ms)"
        description="How quickly volume returns after stop or cancel. 1000 is one second."
        control={
          <div className="w-28">
            <Input
              type="number"
              size="sm"
              aria-label="Fade back up (ms)"
              min={0}
              max={10000}
              step={1}
              value={settings.fadeUpMs}
              onChange={(event) => {
                if (event.target.value !== "" && event.target.validity.valid)
                  update({ fadeUpMs: Number(event.target.value) });
              }}
            />
          </div>
        }
      />
      <p role="status" className="pt-2 text-xs text-muted-foreground">
        {error ??
          (settings.enabled && !settings.outputIds.length
            ? "Select at least one output before recording."
            : "Manual volume changes during recording are preserved. Mute state is unchanged.")}
      </p>
    </SettingsSection>
  );
}
