import type { TerminalOutputUpdate } from "@t3tools/client-runtime/state/terminal";

// libghostty-vt has no clipboard callback, so tmux `set-clipboard` copies
// (OSC 52) are read from the live output stream here. Retire when upstream
// `pingdotgg/t3code#8361` lands.
const OSC52_PREFIX = "\x1b]52;";
// A split sequence is held until its terminator arrives; anything larger is
// not a plausible copy and is dropped rather than buffered forever.
const MAX_PENDING_LENGTH = 1 << 20;

const pendingByTerminal = new WeakMap<object, string>();

function writeClipboardText(text: string): void {
  // Rejects unless this client's document has focus, so only the focused
  // viewer of a shared session takes the copy.
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function decodeOsc52Payload(payload: string): string | null {
  const separator = payload.indexOf(";");
  if (separator === -1) return null;
  const data = payload.slice(separator + 1);
  // `?` is a clipboard read query; answering it would leak the clipboard.
  if (data.length === 0 || data === "?") return null;
  try {
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function partialPrefixLength(text: string): number {
  for (let length = Math.min(OSC52_PREFIX.length - 1, text.length); length > 0; length--) {
    if (OSC52_PREFIX.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

function scanOsc52Clipboard(
  pending: string,
  data: string,
): { readonly copied: string | null; readonly pending: string } {
  const text = pending + data;
  let copied: string | null = null;
  let position = 0;
  for (;;) {
    const start = text.indexOf(OSC52_PREFIX, position);
    if (start === -1) {
      const tail = partialPrefixLength(text.slice(position));
      return { copied, pending: tail === 0 ? "" : text.slice(-tail) };
    }
    const payloadStart = start + OSC52_PREFIX.length;
    const bell = text.indexOf("\x07", payloadStart);
    const st = text.indexOf("\x1b\\", payloadStart);
    const end = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st);
    if (end === -1) {
      const rest = text.slice(start);
      return { copied, pending: rest.length > MAX_PENDING_LENGTH ? "" : rest };
    }
    copied = decodeOsc52Payload(text.slice(payloadStart, end)) ?? copied;
    position = end + (end === st ? 2 : 1);
  }
}

// Only appended output is live; a reset replays history whose copies already
// happened, so it must never rewrite the clipboard.
export function copyOsc52ClipboardFork(
  terminal: object,
  update: TerminalOutputUpdate,
  writeText: (text: string) => void = writeClipboardText,
): void {
  if (update.type === "none") return;
  if (update.type === "reset") {
    pendingByTerminal.delete(terminal);
    return;
  }
  const result = scanOsc52Clipboard(pendingByTerminal.get(terminal) ?? "", update.data);
  if (result.pending.length > 0) pendingByTerminal.set(terminal, result.pending);
  else pendingByTerminal.delete(terminal);
  if (result.copied !== null) writeText(result.copied);
}
