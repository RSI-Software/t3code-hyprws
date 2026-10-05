import { useEffect, useState } from "react";

export function useServerUpdateClockFork(ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A wall clock ticks the restart while the transport is reconnecting.
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
