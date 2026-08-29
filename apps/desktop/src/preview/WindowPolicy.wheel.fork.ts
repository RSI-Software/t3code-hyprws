import * as Effect from "effect/Effect";

export const makeWheelZoomFork = Effect.fn("PreviewManager.makeWheelZoomFork")(function* <E>(
  zoom: (tabId: string, direction: "in" | "out") => Effect.Effect<void, E>,
) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const entries = new Map<
    string,
    { readonly guest: Electron.WebContents; readonly remove: () => void }
  >();
  const remove = (tabId: string) => {
    const entry = entries.get(tabId);
    entries.delete(tabId);
    entry?.remove();
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const tabId of entries.keys()) remove(tabId);
    }),
  );
  return {
    remove: (tabId: string) => Effect.sync(() => remove(tabId)),
    install: (tabId: string, guest: Electron.WebContents) =>
      Effect.sync(() => {
        remove(tabId);
        const zoomChanged = (_event: Electron.Event, direction: "in" | "out") =>
          runFork(
            Effect.suspend(() =>
              entries.get(tabId)?.guest === guest && !guest.isDestroyed()
                ? zoom(tabId, direction)
                : Effect.void,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Preview wheel zoom failed.", { tabId, cause }),
              ),
            ),
          );
        const destroyed = () => {
          if (entries.get(tabId)?.guest === guest) remove(tabId);
        };
        entries.set(tabId, {
          guest,
          remove: () => {
            guest.off("zoom-changed", zoomChanged);
            guest.off("destroyed", destroyed);
          },
        });
        guest.on("zoom-changed", zoomChanged);
        guest.on("destroyed", destroyed);
      }),
  };
});
