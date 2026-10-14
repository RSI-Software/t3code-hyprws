export function writeToRunningTerminalFork<T>(status: string, write: () => T): T | undefined {
  return status === "running" ? write() : undefined;
}
