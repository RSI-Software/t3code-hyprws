import {
  VOICE_DUCKING_DEFAULT_OUTPUT_FORK,
  type VoiceDuckingOutputsFork,
  type VoiceDuckingSettingsFork as DuckingSettings,
} from "@t3tools/contracts";
import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import {
  readVoiceDuckingFork,
  saveVoiceDuckingFork,
  VOICE_DUCKING_CHANGED_FORK,
} from "../../voice-input/ducking.fork";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const valueSettings = [
  {
    key: "targetPercent",
    title: "Target volume",
    description:
      "Percentage of each output’s starting volume. 0% silences it; 100% leaves it unchanged.",
    label: "Ducking target volume (%)",
    max: 100,
    unit: "%",
  },
  {
    key: "fadeDownMs",
    title: "Fade down",
    description: "How quickly output drops when recording starts. 0 is instant.",
    label: "Fade down (ms)",
    max: 10000,
    unit: "ms",
  },
  {
    key: "fadeUpMs",
    title: "Fade back up",
    description: "How quickly volume returns after stop or cancel. 1000 is one second.",
    label: "Fade back up (ms)",
    max: 10000,
    unit: "ms",
  },
] as const;

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

function DuckingValueControl({
  label,
  value,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  unit: "%" | "ms";
  onChange: (value: number) => void;
}) {
  const ratio = value / max;
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <div className="flex w-full items-center gap-3 sm:w-72">
      <input
        aria-label={`${label} slider`}
        aria-valuetext={`${value} ${unit}`}
        className="settings-slider min-w-0 flex-1"
        type="range"
        min={0}
        max={max}
        step={unit === "%" ? 1 : 50}
        style={style}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <div className="w-28 shrink-0">
        <InputGroup>
          <InputGroupInput
            type="number"
            size="sm"
            aria-label={label}
            min={0}
            max={max}
            step={1}
            value={value}
            onChange={(event) => {
              if (event.currentTarget.value !== "" && event.currentTarget.validity.valid)
                onChange(Number(event.currentTarget.value));
            }}
          />
          <InputGroupAddon align="inline-end">
            <span aria-hidden className="text-xs text-muted-foreground">
              {unit}
            </span>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  );
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
  const selectableIds = [VOICE_DUCKING_DEFAULT_OUTPUT_FORK, ...outputs.map((output) => output.id)];
  const choices = [
    {
      id: VOICE_DUCKING_DEFAULT_OUTPUT_FORK,
      label: `System default${defaultLabel ? ` (${defaultLabel})` : ""}`,
    },
    ...outputs,
    ...missing.map((id) => ({ id, label: `${id} (unavailable)` })),
  ];
  const allSelected = selectableIds.every((id) => selectedIds.has(id));
  const selectionLabel =
    allSelected && outputs.length
      ? "All outputs"
      : settings.outputIds.length === 1
        ? settings.outputIds[0] === VOICE_DUCKING_DEFAULT_OUTPUT_FORK
          ? "System default"
          : (outputs.find((output) => selectedIds.has(output.id))?.label ?? "Unavailable output")
        : settings.outputIds.length
          ? `${settings.outputIds.length} selected`
          : "Select outputs";
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
        control={
          <div className="flex min-w-0 items-center gap-1">
            <Menu>
              <MenuTrigger
                render={<Button size="sm" variant="outline" />}
                aria-label="Output devices"
              >
                <span className="max-w-48 truncate">{selectionLabel}</span>
                <ChevronDownIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuCheckboxItem
                  checked={allSelected}
                  disabled={unavailable}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    update({
                      outputIds: checked
                        ? [...new Set([...settings.outputIds, ...selectableIds])]
                        : [],
                    })
                  }
                >
                  Select all
                </MenuCheckboxItem>
                <MenuSeparator />
                {choices.map(({ id, label }) => (
                  <MenuCheckboxItem
                    key={id}
                    checked={selectedIds.has(id)}
                    disabled={id === VOICE_DUCKING_DEFAULT_OUTPUT_FORK && unavailable}
                    closeOnClick={false}
                    onCheckedChange={(checked) => toggleOutput(id, checked)}
                  >
                    {missing.includes(id) ? (
                      <span className="text-muted-foreground">{label}</span>
                    ) : (
                      label
                    )}
                  </MenuCheckboxItem>
                ))}
              </MenuPopup>
            </Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh outputs"
                    disabled={refreshing}
                    onClick={() => {
                      setRefreshing(true);
                      void refresh();
                    }}
                  >
                    <RefreshCwIcon aria-hidden />
                  </Button>
                }
              />
              <TooltipPopup>{refreshing ? "Refreshing outputs…" : "Refresh outputs"}</TooltipPopup>
            </Tooltip>
          </div>
        }
      />
      {valueSettings.map(({ key, title, description, ...control }) => (
        <SettingsRow
          key={key}
          title={title}
          description={description}
          control={
            <DuckingValueControl
              {...control}
              value={settings[key]}
              onChange={(value) => update({ [key]: value })}
            />
          }
        />
      ))}
      <p role="status" className="pt-2 text-xs text-muted-foreground">
        {error ??
          devices?.unavailableReason ??
          (!devices ? "Loading outputs…" : null) ??
          (settings.enabled && !settings.outputIds.length
            ? "Select at least one output before recording."
            : "Manual volume changes during recording are preserved. Mute state is unchanged.")}
      </p>
    </SettingsSection>
  );
}
