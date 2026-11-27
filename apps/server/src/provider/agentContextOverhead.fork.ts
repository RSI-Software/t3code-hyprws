// Exact bytes the fork's instructions and MCP tools add (agentContextBudget.json stays upstream's).
const forkContextOverhead = {
  claudeSystemAppendBytes: 1441,
  codexAdditionalContextBytes: 1441,
  mcpToolListJsonBytes: 5514,
};

export function subtractForkContextOverhead(measured: typeof forkContextOverhead): void {
  measured.claudeSystemAppendBytes -= forkContextOverhead.claudeSystemAppendBytes;
  measured.codexAdditionalContextBytes -= forkContextOverhead.codexAdditionalContextBytes;
  measured.mcpToolListJsonBytes -= forkContextOverhead.mcpToolListJsonBytes;
}
