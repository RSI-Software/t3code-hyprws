import { projectFileRevision } from "@t3tools/contracts";

// Stale-write guard (RSI-Software/t3code-hyprws#1761): the disk revision each
// unsaved draft started from, keyed by the file's optimistic atom. A save sends
// it so the server refuses to replace a newer disk version. An entry without a
// revision skips the check: the panel never showed disk contents, or the user
// chose to overwrite. A reloaded file holds RELOADED until the next edit, so
// an editor still holding the dropped draft cannot write it unchecked.
const RELOADED = Symbol("reloaded");
const draftBases = new Map<object, string | undefined | typeof RELOADED>();

export function captureFileSaveBase(file: object, diskContents: () => string | undefined): void {
  if (draftBases.has(file) && draftBases.get(file) !== RELOADED) return;
  const contents = diskContents();
  draftBases.set(file, contents === undefined ? undefined : projectFileRevision(contents));
}

export function fileSaveBase(file: object): string | undefined | typeof RELOADED {
  return draftBases.get(file);
}

export function isReloadedFileSave(base: ReturnType<typeof fileSaveBase>): base is typeof RELOADED {
  return base === RELOADED;
}

export function markFileSaveReloaded(file: object): void {
  draftBases.set(file, RELOADED);
}

/** Rebases a tracked draft, after a save or an explicit overwrite. */
export function rebaseFileSave(file: object, diskContents: string | undefined): void {
  if (!draftBases.has(file)) return;
  draftBases.set(file, diskContents === undefined ? undefined : projectFileRevision(diskContents));
}

export function forgetFileSaveBase(file: object): void {
  draftBases.delete(file);
}
