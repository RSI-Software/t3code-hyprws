// Fork-owned dispatch guard for external MCP sends (RSI-Software/t3code-hyprws
// device-auth domain). `orchestrationV2.ts` carries only a marked hook that adds
// this schema to `message.dispatch` as `expectedModes`.
import * as Schema from "effect/Schema";

import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** The thread modes a send was vetted under; dispatch refuses it once they change. */
export const ExternalSendModesFork = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
