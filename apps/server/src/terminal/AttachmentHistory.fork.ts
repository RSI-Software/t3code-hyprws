type HistoryPath = (threadId: string, terminalId: string) => string;

export function makeAttachmentHistoryFork(input: {
  readonly historyPath: HistoryPath;
  readonly historyPaths: (threadId: string, terminalId: string) => string[];
  readonly attachmentPath: (threadId: string, terminalId: string, attachmentId: string) => string;
}) {
  return (attachmentId: string | null) => ({
    historyPath: (threadId: string, terminalId: string, _attachmentId?: string | null) =>
      attachmentId
        ? input.attachmentPath(threadId, terminalId, attachmentId)
        : input.historyPath(threadId, terminalId),
    historyPaths: (threadId: string, terminalId: string) =>
      attachmentId
        ? [input.attachmentPath(threadId, terminalId, attachmentId)]
        : input.historyPaths(threadId, terminalId),
  });
}
