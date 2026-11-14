import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { readSpeechRemoteModelFork, saveSpeechRemoteModelFork } from "@t3tools/client-runtime/rpc";
import {
  getEnvironmentSpeechModels,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  SPEECH_REMOTE_MODEL_ID_FORK,
  type EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type SpeechRemoteModelSettingsFork,
  type SpeechRemoteModelUpdateFork,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CloudCogIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { chooseAudioDestination } from "../../speech/voiceConsent";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SelectGroup, SelectGroupLabel, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SecretInput } from "./SecretInput";
import { VoiceDuckingSettingsFork } from "./VoiceDuckingSettings.fork";

type Run = (label: string, work: () => Promise<unknown>) => Promise<void>;
type Environment = Pick<EnvironmentPresentation, "environmentId" | "label" | "serverConfig">;

const CUSTOM = "custom-fork";
const customValue = (environmentId: EnvironmentId) => JSON.stringify([CUSTOM, environmentId]);

/** Fork sections at the end of Settings → Voice. */
export function VoiceSettingsFork() {
  return window.desktopBridge ? <VoiceDuckingSettingsFork /> : null;
}

/** Lists the environment's own models; the custom service is chosen under Transcribe with. */
export const speechModelBrowserPropsFork = <
  Catalog extends { readonly models: readonly EnvironmentSpeechModel[] },
>(
  catalog: Catalog,
) => {
  const hidden = (model: EnvironmentSpeechModel) =>
    model.id === SPEECH_REMOTE_MODEL_ID_FORK && !model.active;
  return catalog.models.some(hidden)
    ? { catalog: { ...catalog, models: catalog.models.filter((model) => !hidden(model)) } }
    : {};
};

async function leaveCustom(connection: PreparedConnection) {
  const { models } = await runEnvironmentSpeech(getEnvironmentSpeechModels(connection));
  if (!models.some((model) => model.active && model.id === SPEECH_REMOTE_MODEL_ID_FORK)) return;
  const local = models.filter((model) => model.id !== SPEECH_REMOTE_MODEL_ID_FORK);
  const fallback =
    local.find((model) => model.state === "installed" && model.recommended) ??
    local.find((model) => model.state === "installed") ??
    local.find((model) => model.recommended) ??
    local[0];
  if (fallback) await runEnvironmentSpeech(selectEnvironmentSpeechModel(connection, fallback.id));
}

/**
 * "Custom via <environment>" under Transcribe with. The service stays a model on the environment,
 * so choosing it selects the environment and its `fork/remote` model, and live preview still works.
 */
export function useCustomTranscriptionFork(input: {
  readonly destination: {
    readonly environmentId: EnvironmentId | null;
    readonly cloudProvider?: string;
  };
  readonly environments: readonly Environment[];
  readonly status: EnvironmentSpeechStatus | null;
  readonly run: Run;
}) {
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const latestChoice = useRef(0);
  const environmentId = input.destination.environmentId;
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const active =
    environmentId !== null &&
    !input.destination.cloudProvider &&
    input.status?.supported === true &&
    input.status.modelId === SPEECH_REMOTE_MODEL_ID_FORK;
  const supported = input.environments.filter(
    ({ serverConfig }) =>
      serverConfig?.environment.capabilities.voiceTranscription === true &&
      serverConfig.environment.capabilities.speechRemoteModelFork === true,
  );
  const chosen = input.environments.find((env) => env.environmentId === environmentId);
  const dialogEnvironment = input.environments.find((env) => env.environmentId === pending);

  const refresh = () => input.run("Could not refresh transcription models", async () => {});

  /**
   * True when the fork handles the value. A plain environment whose active model is the custom
   * service switches to a local model before it becomes the destination.
   */
  const select = (value: string) => {
    const ticket = ++latestChoice.current;
    const choice = supported.find((env) => customValue(env.environmentId) === value);
    if (choice) {
      setPending(choice.environmentId);
      return true;
    }
    const plain = supported.find(
      (env) => JSON.stringify(["environment", env.environmentId]) === value,
    );
    const connection = plain && readPreparedConnection(plain.environmentId);
    if (!plain || !connection) return false;
    void leaveCustom(connection).then(
      () => {
        // A newer choice, such as Off, wins over this one finishing late.
        if (ticket !== latestChoice.current) return;
        chooseAudioDestination({ kind: "environment", environmentId: plain.environmentId });
        if (plain.environmentId === environmentId) void refresh();
      },
      (error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not switch to a local model",
          description: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  };

  return {
    selectProps: active ? { value: customValue(environmentId) } : {},
    select,
    // Rendered before upstream's label, which the sibling selector hides.
    label: active ? (
      <span className="flex min-w-0 items-center gap-2 [&+span]:hidden">
        <CloudCogIcon aria-hidden className="size-4" />
        <span className="truncate">
          Custom
          <span className="text-muted-foreground"> via {chosen?.label ?? "environment"}</span>
        </span>
      </span>
    ) : undefined,
    items: supported.map((env) => (
      <SelectGroup key={env.environmentId}>
        <SelectGroupLabel>Custom via {env.label}</SelectGroupLabel>
        <SelectItem value={customValue(env.environmentId)} aria-label={`Custom via ${env.label}`}>
          <span className="flex items-center gap-2">
            <CloudCogIcon aria-hidden className="size-4" />
            OpenAI-compatible
          </span>
        </SelectItem>
      </SelectGroup>
    )),
    controls: (
      <>
        {active && canManage && environmentId && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                  aria-label="Manage custom service"
                  onClick={() => setPending(environmentId)}
                >
                  <KeyRoundIcon aria-hidden className="size-4" />
                </Button>
              }
            />
            <TooltipPopup>Manage custom service</TooltipPopup>
          </Tooltip>
        )}
        {dialogEnvironment && (
          <CustomTranscriptionDialog
            key={dialogEnvironment.environmentId}
            environment={dialogEnvironment}
            active={active && environmentId === dialogEnvironment.environmentId}
            refresh={refresh}
            close={() => setPending(null)}
          />
        )}
      </>
    ),
  };
}

function CustomTranscriptionDialog({
  environment,
  active,
  refresh,
  close,
}: {
  environment: Environment;
  active: boolean;
  refresh: () => void;
  close: () => void;
}) {
  const formId = useId();
  const id = environment.environmentId;
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const [saved, setSaved] = useState<SpeechRemoteModelSettingsFork | null>(null);
  const [edited, setEdited] = useState<SpeechRemoteModelUpdateFork | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's saved service once its connection is ready
  useEffect(() => {
    if (!prepared) return;
    let current = true;
    runEnvironmentSpeech(readSpeechRemoteModelFork(prepared)).then(
      (settings) => {
        if (!current) return;
        setSaved(settings);
        setLoadFailed(false);
      },
      () => current && setLoadFailed(true),
    );
    return () => {
      current = false;
    };
  }, [prepared]);
  const form =
    edited ?? (saved && { baseUrl: saved.baseUrl, model: saved.model, live: saved.live });
  const configured = Boolean(saved?.baseUrl && saved.model);
  const keyKept = saved?.hasApiKey === true && form?.baseUrl === saved.baseUrl;
  const update = (patch: Partial<SpeechRemoteModelUpdateFork>) =>
    form && setEdited({ ...form, ...patch });
  const host = URL.canParse(form?.baseUrl ?? "") ? new URL(form?.baseUrl ?? "").host : "";

  const apply = async (work: (connection: PreparedConnection) => Promise<unknown>) => {
    if (!prepared || busy) return;
    setError("");
    setBusy(true);
    try {
      await work(prepared);
      close();
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t save this change.");
    }
    setBusy(false);
  };
  const use = (connection: PreparedConnection) =>
    runEnvironmentSpeech(
      selectEnvironmentSpeechModel(connection, SPEECH_REMOTE_MODEL_ID_FORK),
    ).then(() => chooseAudioDestination({ kind: "environment", environmentId: id }));
  const save = () =>
    apply(async (connection) => {
      if (form && edited) {
        const next = await runEnvironmentSpeech(saveSpeechRemoteModelFork(connection, form));
        setSaved(next);
        setEdited(null);
      }
      if (!active) await use(connection);
    });
  const remove = () =>
    apply((connection) =>
      runEnvironmentSpeech(removeEnvironmentSpeechModel(connection, SPEECH_REMOTE_MODEL_ID_FORK)),
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{active ? "Manage custom service" : "Use a custom service?"}</DialogTitle>
          <DialogDescription>
            {environment.label} forwards your recordings to {host || "an OpenAI-compatible service"}
            . For OpenAI live preview, use <code>https://api.openai.com/v1</code> with{" "}
            <code>gpt-live-transcribe</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!prepared ? (
            <p>Connect to {environment.label} to continue.</p>
          ) : loadFailed && !form ? (
            <div className="flex items-center justify-between gap-2">
              <p>Couldn’t load the custom service settings.</p>
              <Button
                type="button"
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
            </div>
          ) : !form ? (
            <p role="status">Loading…</p>
          ) : !canManage ? (
            <p>
              {configured
                ? `Uses the service saved on ${environment.label}.`
                : `Ask an administrator on ${environment.label} to set up a service.`}
            </p>
          ) : (
            <form
              id={formId}
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor={`${formId}-url`}>Base URL</Label>
                <Input
                  id={`${formId}-url`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://api.openai.com/v1"
                  value={form.baseUrl}
                  disabled={busy}
                  onChange={(event) => update({ baseUrl: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${formId}-model`}>Model</Label>
                <Input
                  id={`${formId}-model`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="gpt-live-transcribe"
                  value={form.model}
                  disabled={busy}
                  onChange={(event) => update({ model: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${formId}-key`}>API key</Label>
                <SecretInput
                  id={`${formId}-key`}
                  configured={keyKept}
                  placeholder="Optional"
                  maxLength={8192}
                  value={form.apiKey ?? ""}
                  disabled={busy}
                  onChange={(event) => update({ apiKey: event.target.value })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`${formId}-live`}>Live preview over OpenAI Realtime</Label>
                <Switch
                  id={`${formId}-live`}
                  checked={form.live}
                  disabled={busy}
                  onCheckedChange={(live) => update({ live })}
                />
              </div>
            </form>
          )}
        </DialogPanel>
        {error && (
          <p className="px-6 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          {prepared && canManage && configured && (
            <div className="sm:mr-auto">
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={remove}>
                Remove service
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {prepared && form && canManage ? (
            <Button
              type="submit"
              form={formId}
              size="sm"
              disabled={busy || (active && !edited) || !form.baseUrl.trim() || !form.model.trim()}
            >
              {active ? "Save" : "Save and use"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
