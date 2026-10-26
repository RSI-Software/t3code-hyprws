// Fork-owned stale-write guard for workspace file saves. Client and server hash the same decoded
// text, so a save names its draft's base disk version without resending it. Synchronous because
// `crypto.subtle` is missing on plain-HTTP remote origins.
export function projectFileRevision(contents: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${contents.length}:${(hash >>> 0).toString(36)}`;
}
