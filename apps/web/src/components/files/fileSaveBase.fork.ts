import { projectFileRevision } from "@t3tools/contracts";

// Stale-write guard (RSI-Software/t3code-hyprws#1761): the disk revision each
// unsaved draft started from, keyed by the file's optimistic atom. A save sends
// it so the server refuses to replace a newer disk version. An entry without a
// revision skips the check: the panel never showed disk contents, or the user
// chose to overwrite. A saved or reloaded draft holds SETTLED until the next
// edit, so an editor still holding it cannot resend it unchecked.
const SETTLED = Symbol("settled");
const draftBases = new Map<object, string | undefined | typeof SETTLED>();

export function captureFileSaveBase(file: object, diskContents: () => string | undefined): void {
  if (draftBases.has(file) && draftBases.get(file) !== SETTLED) return;
  const contents = diskContents();
  draftBases.set(file, contents === undefined ? undefined : projectFileRevision(contents));
}

export function fileSaveBase(file: object): string | undefined | typeof SETTLED {
  return draftBases.get(file);
}

export function isSettledFileSave(base: ReturnType<typeof fileSaveBase>): base is typeof SETTLED {
  return base === SETTLED;
}

export function settleFileSave(file: object): void {
  draftBases.set(file, SETTLED);
}

/** Rebases a tracked draft, after a save or an explicit overwrite. */
export function rebaseFileSave(file: object, diskContents: string | undefined): void {
  if (!draftBases.has(file)) return;
  draftBases.set(file, diskContents === undefined ? undefined : projectFileRevision(diskContents));
}
