import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { makeComponentLogger } from "./DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-clerk");

type LaunchSource = "second-instance" | "open-url";
type OpenArguments = (source: LaunchSource, argv: readonly string[]) => Effect.Effect<void>;

// Fork-only: upstream's `second-instance` listener reveals the main window and
// its `open-url` listener claims only provider-auth URLs. The fork opens every
// other launch as a window instead. `DesktopApp` installs the opener; the
// Clerk listeners route through it and keep upstream behavior without one.
const makeDesktopLaunchArguments = () => {
  let openArguments: OpenArguments | undefined;

  /** Installs the window opener; call before `DesktopClerk.configure`. */
  const install = <E>(open: (argv: readonly string[]) => Effect.Effect<void, E>) =>
    Effect.sync(() => {
      openArguments = (source, argv) =>
        open(argv).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to open launch arguments", {
              source,
              argv: [...argv],
              error: Cause.pretty(cause),
            }),
          ),
        );
    });

  /** Binds the listeners' routing to the calling fiber's services. */
  const router = Effect.gen(function* () {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const open = (source: LaunchSource, argv: readonly string[]) => {
      if (!openArguments) return false;
      runFork(openArguments(source, argv));
      return true;
    };
    return {
      /** True when the launch opened as a window instead of revealing main. */
      secondInstance: (argv: readonly string[]) => open("second-instance", argv),
      /** Claims every URL: provider-auth handlers first, then the opener. */
      openUrl: (
        event: { readonly preventDefault: () => void },
        url: string,
        authHandlers: ReadonlyArray<(url: string) => boolean>,
      ) => {
        if (!openArguments) return false;
        event.preventDefault();
        if (authHandlers.some((handle) => handle(url))) return true;
        return open("open-url", [url]);
      },
    } as const;
  });

  return { install, router } as const;
};

/** The desktop process's one router: Electron's app events are process-global. */
export const desktopLaunchArguments = makeDesktopLaunchArguments();
