interface LinearReadConfig {
  readonly environment: { readonly capabilities: { readonly linearIssues?: boolean } };
  readonly settings?: { readonly linearApiKey?: unknown };
}

/** Whether a server reads Linear: a key in its environment, or one saved in Settings since. */
export const readsLinearFork = (config: LinearReadConfig | null | undefined): boolean =>
  config?.environment.capabilities.linearIssues === true ||
  (config?.settings?.linearApiKey !== undefined && config.settings.linearApiKey !== "");
