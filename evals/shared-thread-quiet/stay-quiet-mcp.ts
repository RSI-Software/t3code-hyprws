#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Spike RSI-714: a stdio MCP server with one tool, the structured "no reply" in a shared thread.
import * as NodeReadline from "node:readline";
import { QUIET_TOOL_SPIKE } from "../../apps/server/src/collaborator/CollaboratorMessages.fork.ts";

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const request = JSON.parse(line) as { id?: number | string; method: string };
  if (request.id === undefined) continue;
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "t3", version: "0.0.0" },
        }
      : request.method === "tools/list"
        ? {
            tools: [
              {
                name: QUIET_TOOL_SPIKE,
                description:
                  "Shared threads only: the message is between people, so you add nothing. Call it instead of replying.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          }
        : request.method === "tools/call"
          ? { content: [{ type: "text", text: "Staying quiet." }] }
          : {};
  send({ jsonrpc: "2.0", id: request.id, result });
}
