import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type * as ElectronWindow from "../electron/ElectronWindow.ts";
import { IpcRequester } from "../electron/WindowTargets.fork.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import type { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

interface ReadyRenderer {
  readonly webContents: Electron.WebContents;
  readonly detach: () => void;
}

/**
 * Tracks activation readiness per app window instead of for one main window.
 *
 * Every window that reports ready stays ready until it reports not ready,
 * navigates away, or is destroyed, so closing one window never clears the
 * others. A request goes to the ready window focused most recently; the broker
 * still sends one at a time. Losing a window fails only a request it was
 * handling, and the remaining windows take the queue.
 */
export function makeActivationRenderers(input: {
  readonly broker: DesktopAppActivationBroker;
  readonly electronWindow: ElectronWindow.ElectronWindow["Service"];
}) {
  const ready = new Map<number, ReadyRenderer>();
  let inFlight: number | null = null;

  const pick = (): ReadyRenderer | undefined => {
    for (const window of Effect.runSync(input.electronWindow.windowsByRecency)) {
      const renderer = ready.get(window.webContents.id);
      if (renderer !== undefined) return renderer;
    }
    // A ready window main has since unregistered, such as one whose close was vetoed.
    return ready.values().next().value;
  };

  const send = (request: DesktopAppActivationRequest) => {
    const renderer = pick();
    if (renderer === undefined) throw new Error("No ready desktop renderer.");
    inFlight = renderer.webContents.id;
    renderer.webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
  };

  const remove = (id: number) => {
    const renderer = ready.get(id);
    if (renderer === undefined) return;
    renderer.detach();
    ready.delete(id);
    // A broker clear fails whatever request is dispatched. Only do that when
    // the window that went away was the one handling it, or none remain.
    if (inFlight !== id && ready.size > 0) return;
    inFlight = null;
    input.broker.clearRenderer();
    if (ready.size > 0) input.broker.registerRenderer(send);
  };

  const add = (webContents: Electron.WebContents) => {
    const id = webContents.id;
    if (!ready.has(id)) {
      const onUnavailable = () => remove(id);
      const onNavigation = (
        event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (event.isMainFrame && !event.isSameDocument) remove(id);
      };
      webContents.on("did-start-navigation", onNavigation);
      webContents.once("destroyed", onUnavailable);
      ready.set(id, {
        webContents,
        detach: () => {
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("destroyed", onUnavailable);
        },
      });
    }
    input.broker.registerRenderer(send);
  };

  return {
    /**
     * Records readiness for the requesting window. Returns false only when
     * there is no IPC requester, leaving the caller's single-renderer path in
     * charge; a renderer main did not register is ignored, so it can never
     * clear the app windows' readiness.
     */
    setReady: (isReady: boolean) =>
      Effect.gen(function* () {
        const requester = yield* IpcRequester;
        if (Option.isNone(requester)) return false;
        const sender = yield* input.electronWindow.currentMainOrFirst;
        if (Option.isNone(sender)) return true;
        const webContents = sender.value.webContents;
        if (webContents.id !== requester.value) return true;
        if (!isReady) remove(webContents.id);
        else if (!webContents.isDestroyed()) add(webContents);
        return true;
      }),
  };
}
