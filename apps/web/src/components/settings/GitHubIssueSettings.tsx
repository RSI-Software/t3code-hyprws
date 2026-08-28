import {
  DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE,
  DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE,
  DEFAULT_GITHUB_LINK_OPEN_MODE,
  type GitHubChangeRequestOpenMode,
  type GitHubLinkOpenMode,
} from "@t3tools/contracts/settings";

import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const GITHUB_CHANGE_REQUEST_DESTINATION_LABELS: Record<GitHubChangeRequestOpenMode, string> = {
  native: "Native panel",
  integrated: "T3 Browser",
  external: "External browser",
};

const GITHUB_LINK_DESTINATION_LABELS: Record<GitHubLinkOpenMode, string> = {
  integrated: "T3 Browser",
  external: "External browser",
};

export function GitHubIssueSettingsSection() {
  const template = usePrimarySettings((settings) => settings.githubIssueHandoffPromptTemplate);
  const updateSettings = useUpdatePrimarySettings();
  const githubLinkOpenMode = useClientSettings((settings) => settings.githubLinkOpenMode);
  const githubChangeRequestOpenMode = useClientSettings(
    (settings) => settings.githubChangeRequestOpenMode,
  );
  const updateClientSettings = useUpdateClientSettings();
  const isDirty = template !== DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE;

  return (
    <SettingsSection title="GitHub links">
      <SettingsRow
        {...searchableSetting("github-change-request-destination")}
        description="Choose the default destination for GitHub issue and pull request links. Hover controls always expose every available destination."
        resetAction={
          githubChangeRequestOpenMode !== DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE ? (
            <SettingResetButton
              label="GitHub issue and pull request destination"
              onClick={() =>
                updateClientSettings({
                  githubChangeRequestOpenMode: DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={githubChangeRequestOpenMode}
            onValueChange={(value) => {
              if (value === "native" || value === "integrated" || value === "external") {
                updateClientSettings({ githubChangeRequestOpenMode: value });
              }
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="GitHub issue and pull request destination"
            >
              <SelectValue>
                {GITHUB_CHANGE_REQUEST_DESTINATION_LABELS[githubChangeRequestOpenMode]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(GITHUB_CHANGE_REQUEST_DESTINATION_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("github-link-destination")}
        description="Choose the default destination for other GitHub repository links."
        resetAction={
          githubLinkOpenMode !== DEFAULT_GITHUB_LINK_OPEN_MODE ? (
            <SettingResetButton
              label="GitHub repository link destination"
              onClick={() =>
                updateClientSettings({ githubLinkOpenMode: DEFAULT_GITHUB_LINK_OPEN_MODE })
              }
            />
          ) : null
        }
        control={
          <Select
            value={githubLinkOpenMode}
            onValueChange={(value) => {
              if (value === "integrated" || value === "external") {
                updateClientSettings({ githubLinkOpenMode: value });
              }
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="GitHub repository link destination"
            >
              <SelectValue>{GITHUB_LINK_DESTINATION_LABELS[githubLinkOpenMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(GITHUB_LINK_DESTINATION_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("github-issue-handoff-prompt")}
        description="Controls the unsent text placed in a new thread by Work on this issue."
        resetAction={
          isDirty ? (
            <SettingResetButton
              label="GitHub issue handoff prompt"
              onClick={() =>
                updateSettings({
                  githubIssueHandoffPromptTemplate: DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE,
                })
              }
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={template}
            defaultValue={template}
            onBlur={(event) => {
              const nextTemplate =
                event.target.value.trim() || DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE;
              if (nextTemplate !== template) {
                updateSettings({ githubIssueHandoffPromptTemplate: nextTemplate });
              }
            }}
            rows={5}
            spellCheck={false}
            aria-label="GitHub issue handoff prompt template"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Available fields: <code>{"{{number}}"}</code>, <code>{"{{title}}"}</code>, and{" "}
            <code>{"{{url}}"}</code>. Leaving this blank restores the default.
          </p>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
