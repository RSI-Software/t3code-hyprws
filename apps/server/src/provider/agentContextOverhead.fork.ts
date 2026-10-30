const forkContextOverhead = {
  claudeSystemAppendBytes: 1123,
  codexAdditionalContextBytes: 1123,
  mcpToolListJsonBytes: 5849,
};

export function subtractForkContextOverhead(measured: typeof forkContextOverhead): void {
  measured.claudeSystemAppendBytes -= forkContextOverhead.claudeSystemAppendBytes;
  measured.codexAdditionalContextBytes -= forkContextOverhead.codexAdditionalContextBytes;
  measured.mcpToolListJsonBytes -= forkContextOverhead.mcpToolListJsonBytes;
}
