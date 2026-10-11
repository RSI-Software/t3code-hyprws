// Fork-owned terminal settings.
import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { TerminalSettingsFork } from "../components/settings/TerminalSettings.fork";

function TerminalSettingsRoute() {
  return (
    <SettingsPageContainer>
      <TerminalSettingsFork />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/terminal")({ component: TerminalSettingsRoute });
