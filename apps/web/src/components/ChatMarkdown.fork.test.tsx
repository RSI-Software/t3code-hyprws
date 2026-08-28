import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown GitHub links", () => {
  it("renders issue links as repository-qualified destination controls", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text="[Each stable tag lands through a rehearsed rebase](https://github.com/RSI-Software/t3code-hyprws/issues/167)"
      />,
    );

    expect(html).toContain("RSI-Software/t3code-hyprws#167");
    expect(html).toContain("Each stable tag lands through a rehearsed rebase");
    expect(html).toContain('data-github-link-kind="issue"');
    expect(html).toContain('aria-label="Open RSI-Software/t3code-hyprws#167 in issue panel"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("lucide-panel-right");
    expect(html).toContain('aria-label="Open in issue panel, default"');
    expect(html).toContain('aria-label="Open in external browser"');
    expect(html.indexOf('aria-label="Open in external browser"')).toBeLessThan(
      html.indexOf('aria-label="Open in issue panel, default"'),
    );
  });

  it("does not offer a native panel for repository links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text="[the repository](https://github.com/RSI-Software/t3code-hyprws)"
      />,
    );

    expect(html).toContain("RSI-Software/t3code-hyprws");
    expect(html).toContain("the repository");
    expect(html).toContain('data-github-link-kind="repository"');
    expect(html).toContain('aria-label="Open RSI-Software/t3code-hyprws in external browser"');
    expect(html).toContain('aria-label="Open in external browser, default"');
    expect(html).not.toContain('aria-label="Open in issue panel"');
    expect(html).not.toContain('aria-label="Open in pull request panel"');
  });
});
