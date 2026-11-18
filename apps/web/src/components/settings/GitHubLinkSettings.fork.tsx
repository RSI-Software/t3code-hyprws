import {
  DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE,
  DEFAULT_GITHUB_LINK_OPEN_MODE,
  DEFAULT_GITHUB_REFERENCE_STYLE,
} from "@t3tools/contracts/settings";
import type { ClientSettings } from "@t3tools/contracts/settings";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type GitHubLinkSettingKey =
  | "githubChangeRequestOpenMode"
  | "githubReferenceStyle"
  | "githubLinkOpenMode";

const ROWS = [
  {
    key: "githubChangeRequestOpenMode",
    searchId: "github-change-request-destination",
    label: "GitHub issue and pull request destination",
    description:
      "Choose the default destination for GitHub issue and pull request links. Hover controls always expose every available destination.",
    defaultValue: DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE,
    options: { native: "Native panel", integrated: "T3 Browser", external: "External browser" },
  },
  {
    key: "githubReferenceStyle",
    searchId: "github-reference-style",
    label: "GitHub reference style",
    description:
      "Show issue and pull request references in chat as a chip with the title, or as a plain link whose title shows on hover.",
    defaultValue: DEFAULT_GITHUB_REFERENCE_STYLE,
    options: { chip: "Titled chip", link: "Plain link" },
  },
  {
    key: "githubLinkOpenMode",
    searchId: "github-link-destination",
    label: "GitHub repository link destination",
    description: "Choose the default destination for other GitHub repository links.",
    defaultValue: DEFAULT_GITHUB_LINK_OPEN_MODE,
    options: { integrated: "T3 Browser", external: "External browser" },
  },
] as const satisfies ReadonlyArray<{
  readonly key: GitHubLinkSettingKey;
  readonly searchId: string;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly options: Readonly<Record<string, string>>;
}>;

function GitHubLinkSettingRow({ row }: { readonly row: (typeof ROWS)[number] }) {
  const searchableSetting = useSearchableSetting();
  const value: string = useClientSettings((settings: ClientSettings) => settings[row.key]);
  const options: Readonly<Record<string, string>> = row.options;
  const update = (next: string) =>
    updateClientSettings({ [row.key]: next } as Partial<
      Pick<ClientSettings, GitHubLinkSettingKey>
    >);

  return (
    <SettingsRow
      {...searchableSetting(row.searchId)}
      description={row.description}
      resetAction={
        value !== row.defaultValue ? (
          <SettingResetButton
            ariaLabel={`Reset ${row.label} to default`}
            onClick={() => update(row.defaultValue)}
          />
        ) : null
      }
      control={
        <Select
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string" && next in options) update(next);
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label={row.label}>
            <SelectValue>{options[value]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(options).map(([option, label]) => (
              <SelectItem hideIndicator key={option} value={option}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Settings → Source control: where GitHub links in chat open and how references render. */
export function GitHubLinkSettingsSectionFork() {
  return (
    <SettingsSection title="GitHub links">
      {ROWS.map((row) => (
        <GitHubLinkSettingRow key={row.key} row={row} />
      ))}
    </SettingsSection>
  );
}
