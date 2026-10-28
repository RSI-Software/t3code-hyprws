const forkContextOverhead = {
  claudeSystemAppendBytes: 821,
  codexAdditionalContextBytes: 821,
  mcpToolListJsonBytes: 4853,
};

export function subtractForkContextOverhead(measured: typeof forkContextOverhead): void {
  measured.claudeSystemAppendBytes -= forkContextOverhead.claudeSystemAppendBytes;
  measured.codexAdditionalContextBytes -= forkContextOverhead.codexAdditionalContextBytes;
  measured.mcpToolListJsonBytes -= forkContextOverhead.mcpToolListJsonBytes;
}
