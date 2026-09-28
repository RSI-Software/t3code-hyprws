// The window title names the window's project filter (RSI-Software/t3code-hyprws#1353).
import { composeFilteredWindowTitle } from "@t3tools/shared/windowTitle.fork";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "./branding";
import { resolveServerBackedAppDisplayName } from "./branding.logic";
import { readProjectChooserHost, subscribeProjectChooserHost } from "./projectChooser.fork";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { primaryServerConfigAtom } from "./state/server";

/** Appends the filter to upstream's title; started after `startDocumentTitle`, so it writes last. */
export function startFilteredDocumentTitleFork(): void {
  const apply = () => {
    const title = resolveServerBackedAppDisplayName({
      baseName: APP_BASE_NAME,
      fallbackDisplayName: APP_DISPLAY_NAME,
      fallbackStageLabel: APP_STAGE_LABEL,
      primaryServerVersion:
        appAtomRegistry.get(primaryServerConfigAtom)?.environment.serverVersion ?? null,
    });
    document.title = composeFilteredWindowTitle(
      title,
      readProjectChooserHost()?.titleLabel ?? null,
    );
  };
  appAtomRegistry.subscribe(primaryServerConfigAtom, apply, { immediate: true });
  subscribeProjectChooserHost(apply);
}
