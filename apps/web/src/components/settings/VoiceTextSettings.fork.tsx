import {
  AuthSettingsWriteScope,
  AuthOrchestrationOperateScope,
  VOICE_TEXT_STARTER_PROMPTS_FORK,
  type EnvironmentId,
  type ProjectId,
  type VoiceTextConfigFork,
} from "@t3tools/contracts";
import {
  saveVoiceTextSettingsFork,
  generateVoiceTextContextFork,
} from "@t3tools/client-runtime/rpc";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useRef, useState } from "react";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { useEnvironmentScope, readPreparedConnection } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  deriveProviderInstanceEntries,
  applyProviderInstanceSettings,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { useVoiceTextSettingsFork } from "../../voice-input/useVoiceSettings.fork";
import {
  runVoiceInputRequestFork,
  VOICE_SETTINGS_CHANGED_FORK,
} from "../../voice-input/client.fork";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";

export function VoiceTextSettingsFork({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
}) {
  const { settings, error } = useVoiceTextSettingsFork(environmentId);
  const { environment } = useSettingsScope();
  const providerSettings = useScopedSettings();
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [edited, setEdited] = useState<VoiceTextConfigFork | null>(null);
  const [busy, setBusy] = useState<"save" | "context" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const form =
    edited ?? (projectId ? settings?.projects[projectId] : undefined) ?? settings?.defaults;
  const providers = (environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS).filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), providerSettings),
  );
  const selectedEntry = entries.find(
    (entry) => entry.instanceId === form?.modelSelection.instanceId,
  );
  const update = (patch: Partial<VoiceTextConfigFork>) => {
    if (form) setEdited({ ...form, ...patch });
    setMessage(null);
  };
  const runRequest = async <A,>(
    phase: "save" | "context",
    task: (signal: AbortSignal) => Promise<A>,
    failureMessage: string,
    onSuccess: (result: A) => void,
  ) => {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(phase);
    setMessage(null);
    try {
      const result = await task(controller.signal);
      if (!controller.signal.aborted) onSuccess(result);
    } catch {
      if (!controller.signal.aborted) setMessage(failureMessage);
    }
    if (!controller.signal.aborted) setBusy(null);
  };
  const save = (reset = false) => {
    const prepared = readPreparedConnection(environmentId);
    if (!prepared || !form) return;
    return runRequest(
      "save",
      (signal) =>
        runVoiceInputRequestFork(
          saveVoiceTextSettingsFork(prepared, {
            ...(projectId ? { projectId } : {}),
            config: reset ? null : form,
          }),
          signal,
        ),
      "Could not save text processing settings.",
      () => {
        setEdited(null);
        window.dispatchEvent(new Event(VOICE_SETTINGS_CHANGED_FORK));
        setMessage("Text processing settings saved.");
      },
    );
  };
  const generateContext = () => {
    const prepared = readPreparedConnection(environmentId);
    if (!prepared || !form || !projectId) return;
    return runRequest(
      "context",
      (signal) =>
        runVoiceInputRequestFork(
          generateVoiceTextContextFork(prepared, { projectId, config: form }),
          signal,
        ),
      "Context generation failed. Check the selected provider and model.",
      (result) => {
        setEdited({ ...form, projectContext: result.text });
        setMessage("Context generated. Review it, then save.");
      },
    );
  };
  if (!form)
    return (
      <SettingsSection title="Text processing">
        <p role="status">{error ?? "Loading text processing settings…"}</p>
      </SettingsSection>
    );
  const promptFields = [
    ["cleanupPrompt", "Cleanup prompt", "{{text}}, {{project_context}}, {{recent_messages}}"],
    ["formattingPrompt", "Formatting prompt", "{{text}}, {{project_context}}, {{recent_messages}}"],
    ["contextPrompt", "Context generation prompt", "{{project_sources}}"],
  ] as const;
  return (
    <>
      <SettingsSection title="Text processing">
        <fieldset disabled={!canWrite || busy !== null} className="min-w-0">
          <SettingsRow
            title="Generation model"
            description="Independent of the text generation model used for titles and source control."
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  activeInstanceId={form.modelSelection.instanceId}
                  model={form.modelSelection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  isComposerOwned={false}
                  triggerAriaLabel="Dictation generation model"
                  modelOptionsByInstance={getCustomModelOptionsByInstance(
                    providerSettings,
                    providers,
                    form.modelSelection.instanceId,
                    form.modelSelection.model,
                  )}
                  onInstanceModelChange={(instanceId, model) =>
                    update({ modelSelection: createModelSelection(instanceId, model) })
                  }
                />
                {selectedEntry ? (
                  <TraitsPicker
                    provider={selectedEntry.driverKind}
                    models={selectedEntry.models}
                    model={form.modelSelection.model}
                    modelOptions={form.modelSelection.options}
                    prompt=""
                    onPromptChange={() => {}}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={false}
                    onModelOptionsChange={(options) =>
                      update({
                        modelSelection: createModelSelection(
                          form.modelSelection.instanceId,
                          form.modelSelection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
              </div>
            }
          />
          {(
            [
              [
                "cleanupMode",
                "Cleanup",
                "Correct transcription mistakes while preserving meaning.",
              ],
              [
                "formattingMode",
                "Formatting",
                "Organize the whole draft. Automatic processing runs only after transcription completes.",
              ],
            ] as const
          ).map(([key, title, description]) => (
            <SettingsRow
              key={key}
              title={title}
              description={description}
              control={
                <Select
                  value={form[key]}
                  onValueChange={(value) => {
                    if (value === "off" || value === "manual" || value === "auto")
                      update({ [key]: value });
                  }}
                >
                  <SelectTrigger aria-label={`${title} mode`}>
                    <SelectValue>
                      {form[key] === "auto"
                        ? "Automatic"
                        : form[key] === "manual"
                          ? "Manual"
                          : "Off"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="auto">Automatic</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          ))}
          <SettingsRow
            title="Automatic formatting threshold"
            description="Minimum words in the draft after transcription. Manual formatting has no threshold."
            control={
              <Input
                type="number"
                min={1}
                max={10000}
                value={form.formattingMinWords}
                aria-label="Automatic formatting minimum words"
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isInteger(value) && value >= 1 && value <= 10000)
                    update({ formattingMinWords: value });
                }}
              />
            }
          />
          <SettingsRow
            title="Recent messages"
            description="0 sends no history. 2 includes the latest user and assistant messages, labeled by role."
            control={
              <Input
                type="number"
                min={0}
                max={20}
                value={form.recentMessageCount}
                aria-label="Recent message count"
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isInteger(value) && value >= 0 && value <= 20)
                    update({ recentMessageCount: value });
                }}
              />
            }
          />
        </fieldset>
      </SettingsSection>
      <SettingsSection title="Prompts and project context">
        <fieldset disabled={!canWrite || busy !== null} className="min-w-0">
          {promptFields.map(([key, title, placeholders]) => (
            <SettingsRow
              key={key}
              title={title}
              description={`Available fields: ${placeholders}.`}
              resetAction={
                <SettingResetButton
                  label={title.toLowerCase()}
                  onClick={() => update({ [key]: VOICE_TEXT_STARTER_PROMPTS_FORK[key] })}
                />
              }
            >
              <div className="mt-3 max-w-2xl pb-3.5">
                <Textarea
                  value={form[key]}
                  aria-label={title}
                  rows={5}
                  onChange={(event) => update({ [key]: event.target.value })}
                  spellCheck={false}
                />
              </div>
            </SettingsRow>
          ))}
          <SettingsRow
            title="Project context"
            description={
              projectId
                ? "Editable vocabulary and project summary. Generate reads README.md, AGENTS.md, and package.json from this project."
                : "Optional shared context. Select a project above to generate or save project-specific context."
            }
          >
            <div className="mt-3 max-w-2xl space-y-3 pb-3.5">
              <Textarea
                value={form.projectContext}
                rows={5}
                aria-label="Project context"
                onChange={(event) => update({ projectContext: event.target.value })}
              />
              {projectId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canOperate}
                  onClick={() => void generateContext()}
                >
                  Generate / Refresh context
                </Button>
              ) : null}
            </div>
          </SettingsRow>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3 pt-4">
          <Button
            type="button"
            size="sm"
            disabled={!canWrite || busy !== null || promptFields.some(([key]) => !form[key].trim())}
            onClick={() => void save()}
          >
            {busy === "save" ? "Saving…" : "Save text processing"}
          </Button>
          {projectId && settings?.projects[projectId] ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canWrite || busy !== null}
              onClick={() => void save(true)}
            >
              Use environment defaults
            </Button>
          ) : null}
          {busy === "context" ? (
            <>
              <span role="status" className="text-sm text-muted-foreground">
                Generating context…
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  request.current?.abort();
                  setBusy(null);
                }}
              >
                Cancel
              </Button>
            </>
          ) : null}
          {message ? (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </>
  );
}
