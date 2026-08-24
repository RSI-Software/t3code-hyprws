import { useSyncExternalStore } from "react";

type PreferenceSource = {
  getSnapshot: () => boolean;
  subscribe: (listener: () => void) => () => void;
};
let source: PreferenceSource = { getSnapshot: () => false, subscribe: () => () => {} };

export function bindIgnoredFilesPreferenceFork(preference: PreferenceSource): void {
  source = preference;
}

export function useShowIgnoredFiles(): boolean {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
