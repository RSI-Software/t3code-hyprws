// Fork-owned external MCP settlement contract (device-auth domain).
import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, ThreadId } from "./baseSchemas.ts";

/** The original command's acknowledgement; read the thread for its current state. */
export const ExternalMcpSettlementResultFork = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  sequence: Schema.Number,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
});
export type ExternalMcpSettlementResultFork = typeof ExternalMcpSettlementResultFork.Type;
