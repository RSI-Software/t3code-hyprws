import type { DesktopPreviewFavicon, PreviewSessionSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  RightPanelTabs,
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
  tabMuteMenuItem,
} from "./RightPanelTabs";
function shortcutEvent(
  key: string,
  overrides: Partial<Parameters<typeof surfaceShortcutActionForKey>[1]> = {},
): Parameters<typeof surfaceShortcutActionForKey>[1] {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ...overrides,
  };
}
const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};
const sessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
};
const favicon = (dataUrl: string, pageUrl: string): DesktopPreviewFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});
function overlay(
  icon: DesktopPreviewFavicon | null,
  audio?: {
    audible?: boolean;
    audioMuted?: boolean;
  },
) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    audioMuted: audio?.audioMuted ?? false,
    audible: audio?.audible ?? false,
    controller: "none" as const,
    favicon: icon,
  };
}
function renderTabs(
  first: DesktopPreviewFavicon | null,
  second?: DesktopPreviewFavicon,
  audio?: {
    audible?: boolean;
    audioMuted?: boolean;
  },
  previewRuntimeTabId: ((tabId: string) => string) | null = (tabId) => `runtime:${tabId}`,
  options: {
    empty?: boolean;
    issuesAvailable?: boolean;
  } = {},
) {
  const surfaces = options.empty ? [] : second ? [previewSurface, secondSurface] : [previewSurface];
  return renderToStaticMarkup(
    <RightPanelTabs
      mode="inline"
      surfaces={surfaces}
      activeSurfaceId={options.empty ? null : previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{
        "tab-1": overlay(first, audio),
        ...(second ? { "tab-2": overlay(second) } : {}),
      }}
      {...(previewRuntimeTabId ? { previewRuntimeTabId } : {})}
      terminalLabelsById={new Map()}
      onActivate={() => undefined}
      onCloseSurface={() => undefined}
      onCloseOtherSurfaces={() => undefined}
      onCloseSurfacesToRight={() => undefined}
      onCloseAllSurfaces={() => undefined}
      onCopyFilePath={() => undefined}
      onAddBrowser={() => undefined}
      onAddTerminal={() => undefined}
      onAddPullRequest={() => undefined}
      onAddDiff={() => undefined}
      onAddFiles={() => undefined}
      onAddAgents={() => undefined}
      onAddIssues={() => undefined}
      liveAgentCount={0}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      issuesAvailable={options.issuesAvailable ?? false}
      agentsAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>,
  );
}
describe("RightPanelTabs surface launchers", () => {
  it("offers the capability-gated Issues action in the shared launcher model", () => {
    const html = renderTabs(null, undefined, undefined, undefined, {
      empty: true,
      issuesAvailable: true,
    });
    expect(html).toContain(">Issues<");
    expect(html).toContain('data-surface-launcher-keys="BI"');
  });
});
