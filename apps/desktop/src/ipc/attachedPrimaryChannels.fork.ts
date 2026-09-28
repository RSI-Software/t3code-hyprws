// Attached-primary IPC channels (RSI-Software/t3code-hyprws#1350), re-exported
// through `channels.ts` so main and preload name them one way.
export const GET_ATTACHED_PRIMARY_BOOTSTRAP_CHANNEL = "desktop:get-attached-primary-bootstrap";
export const REFRESH_ATTACHED_PRIMARY_BOOTSTRAP_CHANNEL =
  "desktop:refresh-attached-primary-bootstrap";
export const REJECT_ATTACHED_PRIMARY_CHANNEL = "desktop:reject-attached-primary";
