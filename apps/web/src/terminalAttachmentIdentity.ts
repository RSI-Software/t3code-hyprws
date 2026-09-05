import { boundedTerminalAttachmentId } from "@t3tools/client-runtime/state/checkout-move";

const VIEWER_ID_STORAGE_KEY = "t3code:terminal-viewer-id:v1";

let memoryViewerId: string | null = null;

export function terminalViewerId(): string {
  if (memoryViewerId !== null) return memoryViewerId;
  const stored =
    typeof window !== "undefined" ? window.localStorage.getItem(VIEWER_ID_STORAGE_KEY) : null;
  memoryViewerId =
    stored?.trim() ||
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join("-");
  if (typeof window !== "undefined" && stored !== memoryViewerId) {
    window.localStorage.setItem(VIEWER_ID_STORAGE_KEY, memoryViewerId);
  }
  return memoryViewerId;
}

export function terminalAttachmentId(terminalId: string): string {
  return boundedTerminalAttachmentId(terminalViewerId(), terminalId);
}
