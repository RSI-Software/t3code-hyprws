import * as Schema from "effect/Schema";

/**
 * Fork: how a GitHub link opens — in the integrated browser or the external
 * one — and how a change request link opens, which also offers the native
 * panel. These live beside — not inside — upstream's `settings.ts`, whose
 * schema carries only the marked hook lines that spread them into the client
 * settings and patch schemas.
 */

export const GitHubLinkOpenMode = Schema.Literals(["integrated", "external"]);
export type GitHubLinkOpenMode = typeof GitHubLinkOpenMode.Type;
export const DEFAULT_GITHUB_LINK_OPEN_MODE: GitHubLinkOpenMode = "external";

export const GitHubChangeRequestOpenMode = Schema.Literals(["native", "integrated", "external"]);
export type GitHubChangeRequestOpenMode = typeof GitHubChangeRequestOpenMode.Type;
export const DEFAULT_GITHUB_CHANGE_REQUEST_OPEN_MODE: GitHubChangeRequestOpenMode = "native";
