import { type RefObject, useEffect, useEffectEvent } from "react";

export function useTerminalRetargetEffectFork(
  attached: boolean,
  launchIdentity: string,
  launchIdentityRef: RefObject<string | null>,
  retarget: () => void,
) {
  const retargetNow = useEffectEvent(retarget);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retargets the attached terminal process when the launch location changes, deferring hidden splits until they reattach.
  useEffect(() => {
    if (launchIdentityRef.current === launchIdentity || !attached) return;
    launchIdentityRef.current = launchIdentity;
    retargetNow();
  }, [attached, launchIdentity, launchIdentityRef]);
}
