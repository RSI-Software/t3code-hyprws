import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";

const noBrowserSessions = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.die("unexpected getSession"),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

// A shared real-manager fixture without test registration or Electron windows.
// Profile integration supplies the real BrowserSession layer over mock Electron storage.
export const previewManagerFixtureLayer = (
  sessions: Layer.Layer<BrowserSession.BrowserSession> = noBrowserSessions,
) =>
  PreviewManager.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
        register: () => Effect.void,
        recordMetrics: () => Effect.void,
        shutdown: Effect.void,
      }),
    ),
    Layer.provideMerge(sessions),
    Layer.provideMerge(
      Layer.succeed(
        DesktopEnvironment.DesktopEnvironment,
        DesktopEnvironment.DesktopEnvironment.of({
          browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
          dirname: "/tmp/t3/desktop",
          path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
    ),
    Layer.provideMerge(FileSystem.layerNoop({})),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
    Layer.provideMerge(DesktopBrowserHost.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );
