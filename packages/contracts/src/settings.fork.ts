import * as Schema from "effect/Schema";

/**
 * Fork: how a GitHub link opens (integrated or external browser) and how a change request link
 * opens, which also offers the native panel. Upstream `settings.ts` only carries the marked hook
 * lines that spread these into the client settings and patch schemas.
 */

export const GitHubLinkOpenMode = Schema.Literals(["integrated", "external"]);
export type GitHubLinkOpenMode = typeof GitHubLinkOpenMode.Type;
export const DEFAULT_GITHUB_LINK_OPEN_MODE: GitHubLinkOpenMode = "external";

export const GitHubChangeRequestOpenMode = Schema.Literals(["native", "integrated", "external"]);
export type GitHubChangeRequestOpenMode = typeof GitHubChangeRequestOpenMode.Type;
export const DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE: GitHubChangeRequestOpenMode = "native";
