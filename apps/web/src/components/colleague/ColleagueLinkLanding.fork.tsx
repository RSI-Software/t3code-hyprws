// Fork-only (colleague-collab): a colleague link is https so any chat makes it clickable. In a
// browser it first offers the T3 Code app, which pairs through the `t3code://pair` app link.
import { COLLEAGUE_THREAD_LINK_PARAM } from "@t3tools/contracts";
import { buildPairingAppLink } from "@t3tools/shared/remote";
import { type ReactNode, useState } from "react";

import { isElectron } from "~/env";

import { Button } from "../ui/button";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/** The landing for a colleague link opened in a browser, until the colleague continues here. */
export function useColleagueLinkLandingFork(enabled: boolean): ReactNode | null {
  // Read once: pairing in this browser strips the token from the URL.
  const [href] = useState(() => window.location.href);
  const [continued, setContinued] = useState(false);
  const isColleagueLink = new URL(href).searchParams.has(COLLEAGUE_THREAD_LINK_PARAM);
  if (!enabled || isElectron || !isColleagueLink || continued) return null;
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
