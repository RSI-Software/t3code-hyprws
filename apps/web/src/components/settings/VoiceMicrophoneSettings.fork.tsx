import { useCallback, useEffect, useState } from "react";
import {
  readVoiceMicrophoneFork,
  saveVoiceMicrophoneFork,
} from "../../voice-input/microphone.fork";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function VoiceMicrophoneSettingsFork() {
  const [deviceId, setDeviceId] = useState(readVoiceMicrophoneFork);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      navigator.mediaDevices.enumerateDevices().then(
        (available) => {
          setDevices(available.filter((d) => d.kind === "audioinput" && d.deviceId !== "default"));
          setError(null);
        },
        () =>
          setError("Could not list microphones. Check microphone access in your system settings."),
      ),
    [],
  );
  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [refresh]);
  const requestAccess = async () => {
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await refresh();
    } catch {
      setError("Microphone access was denied. Allow it in your system settings and try again.");
    }
    setBusy(false);
  };
  const selected = devices.find((device) => device.deviceId === deviceId);
  return (
    <SettingsSection title="Microphone">
      <SettingsRow
        title="Input device"
        description="Used on this desktop. Changes are saved automatically."
        control={
          <div className="w-full sm:w-72">
            <Select
              value={deviceId || "system-default"}
              onValueChange={(value) => {
                if (value === null) return;
                const next = value === "system-default" ? "" : value;
                try {
                  saveVoiceMicrophoneFork(next);
                  setDeviceId(next);
                  setError(null);
                } catch {
                  setError("Could not save the microphone selection.");
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Dictation microphone">
                <SelectValue>
                  {deviceId
                    ? selected
                      ? selected.label || `Microphone ${devices.indexOf(selected) + 1}`
                      : "Selected microphone unavailable"
                    : "System default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="system-default">System default</SelectItem>
                {deviceId && !selected ? (
                  <SelectItem value={deviceId} disabled>
                    Selected microphone unavailable
                  </SelectItem>
                ) : null}
                {devices
                  .filter((d) => d.deviceId)
                  .map((device, index) => (
                    <SelectItem key={device.deviceId} value={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          </div>
        }
      >
        {!devices.some((device) => device.label) || error ? (
          <div className="flex flex-wrap items-center gap-3 py-3">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void requestAccess()}
            >
              {busy ? "Checking…" : "Allow microphone access"}
            </Button>
            <p className="text-xs text-muted-foreground">Allow access to show microphone names.</p>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
