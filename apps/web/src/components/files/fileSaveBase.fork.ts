import { projectFileRevision } from "@t3tools/contracts";

// Stale-write guard (RSI-Software/t3code-hyprws#1761): the disk revision each
// unsaved draft started from, keyed by the file's optimistic atom. A save sends
// it so the server refuses to replace a newer disk version. An entry without a
// revision skips the check: the panel never showed disk contents, or the user
// chose to overwrite.
const draftBases = new Map<object, string | undefined>();

export function captureFileSaveBase(file: object, diskContents: () => string | undefined): void {
  if (draftBases.has(file)) return;
  const contents = diskContents();
  draftBases.set(file, contents === undefined ? undefined : projectFileRevision(contents));
}

export function fileSaveBase(file: object): string | undefined {
  return draftBases.get(file);
}

/** Rebases a tracked draft, after a save or an explicit overwrite. */
export function rebaseFileSave(file: object, diskContents: string | undefined): void {
  if (!draftBases.has(file)) return;
  draftBases.set(file, diskContents === undefined ? undefined : projectFileRevision(diskContents));
}

export function forgetFileSaveBase(file: object): void {
  draftBases.delete(file);
}
