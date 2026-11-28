// Fork-only (colleague-collab): a collaborator link typed into the backend field stays as typed
// until its pairing code is whole, so it asks to open once, not once per keystroke.
import {
  COLLABORATOR_THREAD_LINK_PARAM,
  COLLEAGUE_INVITE_LINK_PARAM,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
} from "@t3tools/contracts";
import { getPairingTokenFromUrl } from "@t3tools/shared/remote";

const WHOLE_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`, "i");

/** `other` is not a collaborator link; `partial` is one still being typed; `whole` can open. */
export function collaboratorLinkInputFork(value: string) {
  const link = value.trim();
  const url = URL.parse(link);
  if (
    url === null ||
    (!url.searchParams.get(COLLABORATOR_THREAD_LINK_PARAM)?.trim() &&
      !url.searchParams.get(COLLEAGUE_INVITE_LINK_PARAM)?.trim())
  )
    return { kind: "other" } as const;
  const code = getPairingTokenFromUrl(url);
  return code !== null && WHOLE_CODE.test(code)
    ? ({ kind: "whole", link } as const)
    : ({ kind: "partial" } as const);
}
