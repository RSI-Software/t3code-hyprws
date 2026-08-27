import { DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function GitHubIssueSettingsSection() {
  const template = usePrimarySettings((settings) => settings.githubIssueHandoffPromptTemplate);
  const updateSettings = useUpdatePrimarySettings();
  const isDirty = template !== DEFAULT_GITHUB_ISSUE_HANDOFF_PROMPT_TEMPLATE;

  return (
    <SettingsSection title="GitHub issues">
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
