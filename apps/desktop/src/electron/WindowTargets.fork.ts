import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The webContents id of the renderer whose IPC request is running.
 *
 * `DesktopIpc` provides it around every handler, so a window resolved anywhere
 * inside that request (a dialog owner, an SSH prompt, fullscreen state) is the
 * window that asked. Outside a request it is none, and resolution falls to the
 * most recently focused app window.
 */
export const IpcRequester = Context.Reference<Option.Option<number>>(
  "@t3tools/desktop/electron/IpcRequester",
  { defaultValue: Option.none },
);

/** Runs an IPC handler with its sender as the ambient requester. */
export const withIpcSender =
  (event: { readonly sender?: { readonly id: number } } | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    event?.sender === undefined
      ? effect
      : Effect.provideService(effect, IpcRequester, Option.some(event.sender.id));
