import { FORK_INSTALL_SCRIPT_URL, isForkServiceVersion } from "@t3tools/shared/forkVersion";

/** Upstream's recovery names `t3.codes/install.sh`, which installs only upstream releases. */
export function forkLauncherProtocolReason(
  launcherProtocol: number,
  requiredProtocol: number,
  version: string,
): { readonly reason?: string } {
  if (!isForkServiceVersion(version)) return {};
  return {
    reason: [
      `The installed service launcher speaks protocol ${launcherProtocol}, but t3@${version} requires protocol ${requiredProtocol}.`,
      `On the server machine, install this exact CLI: \`curl -fsSL ${FORK_INSTALL_SCRIPT_URL} | T3CODE_VERSION=${version} sh\`.`,
      `Check that \`t3 --version\` prints ${version} and that \`which -a t3\` lists no older t3 (such as an npm or nvm install) first, then run \`~/.local/bin/t3 service install\` (the installer's default path).`,
      "Updating the desktop app does not update this CLI, and `t3 service update` only repairs the service with whichever CLI runs it.",
    ].join(" "),
  };
}
