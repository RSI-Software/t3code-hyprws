import { environmentMcpUrl } from "@t3tools/client-runtime/connection";
import { useGT } from "gt-react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import type { EnvironmentPresentation } from "~/state/environments";

/**
 * Builds without T3 Connect config get the environment's own MCP URL and approve on
 * its `/connect-agent` page with a code, instead of on the hosted app.
 */
export const ownAddressMcp = !hasCloudPublicConfig();

export function ownMcpUrl(environment: EnvironmentPresentation): string | null {
  return ownAddressMcp ? environmentMcpUrl({ entry: environment.entry }) : null;
}

/** The wizard's gate, always open: the dialog only opens the wizard when `ownMcpUrl` exists. */
export function ownAddressGate(environment: EnvironmentPresentation) {
  return {
    gate: { kind: "open", mcpUrl: ownMcpUrl(environment) ?? "" } as const,
    connecting: false,
    check: async () => {},
    refreshList: () => undefined,
    turnOn: async () => {},
    operationError: null,
    tunnelLimit: null,
  };
}

/** Cloud apps fetch the URL from the internet, so a plain-http or loopback one fails there. */
export function OwnAddressNote({ environment }: { readonly environment: EnvironmentPresentation }) {
  const gt = useGT();
  const url = ownMcpUrl(environment);
  if (url === null || new URL(url).protocol === "https:") return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      {gt(
        "T3 Connect is off in this build. Cloud apps like Claude and Poke cannot reach {url}. Use an app on this computer, or an https route such as Tailscale HTTPS.",
        { url },
      )}
    </p>
  );
}
