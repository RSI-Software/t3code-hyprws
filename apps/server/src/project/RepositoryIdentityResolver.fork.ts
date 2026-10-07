export function originDefaultRemoteFork(remotes: ReadonlyMap<string, string>) {
  const remoteUrl = remotes.get("origin");
  return remoteUrl ? { remoteName: "origin", remoteUrl } : null;
}
