// Exact bytes the fork's instructions and MCP tools add (agentContextBudget.json stays upstream's).
const forkContextOverhead = {
  claudeSystemAppendBytes: 1511,
  codexAdditionalContextBytes: 1511,
  mcpToolListJsonBytes: 4534,
};

export function subtractForkContextOverhead(measured: typeof forkContextOverhead): void {
  measured.claudeSystemAppendBytes -= forkContextOverhead.claudeSystemAppendBytes;
  measured.codexAdditionalContextBytes -= forkContextOverhead.codexAdditionalContextBytes;
  measured.mcpToolListJsonBytes -= forkContextOverhead.mcpToolListJsonBytes;
}
