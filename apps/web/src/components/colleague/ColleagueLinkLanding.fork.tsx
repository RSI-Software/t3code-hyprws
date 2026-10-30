// Fork-only (colleague-collab): a colleague link is https so any chat makes it clickable. In a
// browser it first offers the T3 Code app, which pairs through the `t3code://pair` app link.
import type { AuthSessionState } from "@t3tools/contracts";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import { type ReactNode, useState } from "react";

import { isElectron } from "~/env";
import { PairingRouteSurface } from "../auth/PairingRouteSurface";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { linkThreadIdFork, sharedThreadPathFork } from "./colleagueLink.fork";

interface PairingGate {
  readonly auth: AuthSessionState["auth"];
  readonly errorMessage?: string;
}

/** A colleague link opened in a browser: the landing, then pairing that opens the shared thread. */
export function useColleagueLinkLandingFork(gate: PairingGate | undefined): ReactNode | null {
  // Read once: pairing in this browser strips the token from the URL.
  const [href] = useState(() => window.location.href);
  const [continued, setContinued] = useState(false);
  const threadId = linkThreadIdFork(href);
  if (gate === undefined || isElectron || !threadId) return null;
  if (continued) {
    return (
      <PairingRouteSurface
        auth={gate.auth}
        // A full load recreates the connection with the new pairing cookie, as upstream pairing does.
        onAuthenticated={() =>
          void sharedThreadPathFork(threadId).then((path) => window.location.replace(path))
        }
        {...(gate.errorMessage ? { initialErrorMessage: gate.errorMessage } : {})}
      />
    );
  }
  const onPhone = /android|iphone|ipad/i.test(navigator.userAgent);
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="A thread was shared with you"
        description="Open it in T3 Code, or continue in this browser. Your messages run on the sharer's machine."
      />
      <div className="mt-6 flex flex-wrap gap-2">
        <Button render={<a href={buildPairingAppLink(href)} />}>
          {onPhone ? "Open in app" : "Open in desktop app"}
        </Button>
        <Button variant="outline" onClick={() => setContinued(true)}>
          Continue in this browser
        </Button>
      </div>
    </StandalonePage>
  );
}
