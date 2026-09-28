import { DesktopEnvironmentBootstrapSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AttachedPrimaryRejectReasonSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as DesktopAttachedPrimary from "../../app/DesktopAttachedPrimary.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// The single attached primary bootstrap the renderer promotes to its primary
// target (RSI-Software/t3code-hyprws#1350). The sync read serves main's last
// verified cache only — sync handlers cannot run async discovery — and the
// async refresh advances it.
export const getAttachedPrimaryBootstrap = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_ATTACHED_PRIMARY_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.localServerDiscovery.attachedBootstrap")(function* () {
    const attached = yield* DesktopAttachedPrimary.DesktopAttachedPrimary;
    const cached = attached.cached();
    if (Option.isNone(cached)) {
      return null;
    }
    return DesktopAttachedPrimary.attachedBootstrapOf(cached.value);
  }),
});

// Poll and focus refresh. Client-only only: a late-started server promotes,
// and managed mode never attaches.
export const refreshAttachedPrimaryBootstrap = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REFRESH_ATTACHED_PRIMARY_BOOTSTRAP_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.localServerDiscovery.refreshAttachedBootstrap")(function* () {
    const attached = yield* DesktopAttachedPrimary.attachedPrimaryInClientOnly;
    if (Option.isNone(attached)) {
      return null;
    }
    const refreshed = yield* attached.value.refreshOrAttach;
    if (Option.isNone(refreshed)) {
      return null;
    }
    return DesktopAttachedPrimary.attachedBootstrapOf(refreshed.value);
  }),
});

// The renderer reports a dead attached bearer: a transport error or a 401
// that survived one re-mint, naming the bearer that failed. Main drops the
// attachment only when that bearer is still the attached one.
export const rejectAttachedPrimary = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REJECT_ATTACHED_PRIMARY_CHANNEL,
  payload: Schema.Struct({
    bearerToken: Schema.String,
    reason: AttachedPrimaryRejectReasonSchema,
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localServerDiscovery.rejectAttached")(function* ({
    bearerToken,
    reason,
  }) {
    const attached = yield* Effect.serviceOption(DesktopAttachedPrimary.DesktopAttachedPrimary);
    if (Option.isSome(attached)) {
      yield* attached.value.reject(bearerToken, reason);
    }
  }),
});
