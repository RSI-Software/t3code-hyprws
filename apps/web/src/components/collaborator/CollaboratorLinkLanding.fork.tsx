// Fork-only (colleague-collab): a collaborator link is https so any chat makes it clickable. In a
// browser it first offers the T3 Code app, which pairs through the `t3code://pair` app link.
import type { AuthSessionState } from "@t3tools/contracts";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import { useGT } from "gt-react";
import { type ReactNode, useState } from "react";

import { isElectron } from "~/env";
import { fetchSessionState } from "../../environments/primary/auth";
import { PairingRouteSurface } from "../auth/PairingRouteSurface";
import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  linkColleagueInviteFork,
  linkThreadIdFork,
  sharedThreadPathFork,
} from "./collaboratorLink.fork";

interface PairingGate {
  readonly auth: AuthSessionState["auth"];
  readonly errorMessage?: string;
}

/**
 * A collaborator link opened in a browser: the landing, then pairing that opens the shared thread.
 * A colleague-only invite needs a T3 Code app of the invitee's own, so it offers only the app.
 */
export function useCollaboratorLinkLandingFork(gate: PairingGate | undefined): ReactNode | null {
  const gt = useGT();
  // Read once: pairing in this browser strips the token from the URL.
  const [href] = useState(() => window.location.href);
  const [continued, setContinued] = useState(false);
  const threadId = linkThreadIdFork(href);
  const invite = linkColleagueInviteFork(href);
  if (gate === undefined || isElectron || (!threadId && !invite)) return null;
  const onPhone = /android|iphone|ipad/i.test(navigator.userAgent);
  const openInApp = (
    <Button render={<a href={buildPairingAppLink(href)} />}>
      {onPhone ? gt("Open in app") : gt("Open in desktop app")}
    </Button>
  );
  if (!threadId) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title={gt("You are invited as a colleague")}
          description={gt(
            "Open this link in your own T3 Code app. You each save the other, then share threads without a link.",
          )}
        />
        <div className="mt-6 flex flex-wrap gap-2">{openInApp}</div>
      </StandalonePage>
    );
  }
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
  // A link's token works once, so a browser that already paired opens the thread without it.
  const continueInBrowser = () =>
    void fetchSessionState()
      .then(({ authenticated }) => authenticated)
      .catch(() => false)
      .then((authenticated) =>
        authenticated
          ? sharedThreadPathFork(threadId).then((path) => window.location.replace(path))
          : setContinued(true),
      );
  return (
    <StandalonePage>
      <StandalonePageHeader
        title={gt("A thread was shared with you")}
        description={gt(
          "Open it in T3 Code, or continue in this browser. Your messages run on the sharer's machine.",
        )}
      />
      <div className="mt-6 flex flex-wrap gap-2">
        {openInApp}
        <Button variant="outline" onClick={continueInBrowser}>
          {gt("Continue in this browser")}
        </Button>
      </div>
    </StandalonePage>
  );
}
