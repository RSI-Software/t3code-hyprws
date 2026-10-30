const forkContextOverhead = {
  claudeSystemAppendBytes: 1108,
  codexAdditionalContextBytes: 1108,
  mcpToolListJsonBytes: 5819,
};

export function subtractForkContextOverhead(measured: typeof forkContextOverhead): void {
  measured.claudeSystemAppendBytes -= forkContextOverhead.claudeSystemAppendBytes;
  measured.codexAdditionalContextBytes -= forkContextOverhead.codexAdditionalContextBytes;
  measured.mcpToolListJsonBytes -= forkContextOverhead.mcpToolListJsonBytes;
}
