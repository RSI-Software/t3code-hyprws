import { buildRemoteOpenUrl } from "@t3tools/contracts";

// VS Code handles a vscode-remote link in its last active window unless it carries
// `windowId=_blank`; a window already showing the folder is still reused.
export const buildRemoteOpenUrlInOwnWindow = (input: Parameters<typeof buildRemoteOpenUrl>[0]) => {
  const url = buildRemoteOpenUrl(input);
  return url?.includes("://vscode-remote/") && !input.isFile ? `${url}?windowId=_blank` : url;
};
