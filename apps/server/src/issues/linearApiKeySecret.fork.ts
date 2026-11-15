import type { ServerSettings } from "@t3tools/contracts";

/** The Linear API key saved in Settings lives in the secret store, never in a file or a client. */
export const linearApiKeySecretFork = (
  settings: ServerSettings,
  mapFields: (
    fields: Readonly<Record<string, unknown>>,
    secretFields: ReadonlyArray<string>,
    name: () => string,
  ) => Record<string, unknown>,
) =>
  mapFields({ linearApiKey: settings.linearApiKey }, ["linearApiKey"], () => "linear-api-key") as {
    readonly linearApiKey: string;
  };
