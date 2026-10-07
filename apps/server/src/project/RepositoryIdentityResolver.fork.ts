export function originDefaultRemoteFork(remotes: ReadonlyMap<string, string>): string | null {
  return remotes.has("origin") ? "origin" : null;
}
