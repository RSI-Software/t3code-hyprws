import { useEffect, useEffectEvent, useRef } from "react";
import type { projectEnvironment } from "~/state/projects";

export function ignoredListingEnvironmentFork(
  environment: typeof projectEnvironment,
  includeIgnored: boolean,
) {
  const listEntries: typeof environment.listEntries = (request) =>
    environment.listEntries({ ...request, input: { ...request.input, includeIgnored } });
  return () => ({ ...environment, listEntries });
}

export function useIgnoredListingInvalidationFork(includeIgnored: boolean, invalidate: () => void) {
  const loadedPreference = useRef(includeIgnored);
  const invalidateNow = useEffectEvent(invalidate);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Invalidates external directory listing requests and refetches when the persisted visibility preference changes.
  useEffect(() => {
    if (loadedPreference.current === includeIgnored) return;
    loadedPreference.current = includeIgnored;
    invalidateNow();
  }, [includeIgnored]);
}
