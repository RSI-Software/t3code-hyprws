import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";

/** An http(s) link the operating system handed to T3 Code as the default browser. */
export const isWebLink = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

/**
 * Web links macOS opens with T3 Code once it is the default browser. They can
 * arrive before the app is ready (the link that launched it) or while the web
 * app reloads, so they wait until the renderer says it is listening.
 */
export class DesktopWebLinks extends Context.Service<
  DesktopWebLinks,
  {
    /** Queues a link and delivers it as soon as the renderer is listening. */
    readonly receive: (url: string) => Effect.Effect<void>;
    /** The renderer started or stopped listening; listening flushes queued links. */
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopWebLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const pending: Array<string> = [];
  let rendererReady = false;

  const flush = Effect.gen(function* () {
    if (!rendererReady || pending.length === 0) return;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.webContents.isDestroyed()) return;
    for (const url of pending.splice(0)) {
      window.value.webContents.send(WEB_LINK_OPEN_CHANNEL, url);
    }
    yield* electronWindow.reveal(window.value);
  });

  return DesktopWebLinks.of({
    receive: (url) =>
      Effect.suspend(() => {
        pending.push(url);
        return flush;
      }).pipe(Effect.withSpan("DesktopWebLinks.receive")),
    setRendererReady: (ready) =>
      Effect.suspend(() => {
        rendererReady = ready;
        return flush;
      }).pipe(Effect.withSpan("DesktopWebLinks.setRendererReady")),
  });
});

export const layer = Layer.effect(DesktopWebLinks, make);
