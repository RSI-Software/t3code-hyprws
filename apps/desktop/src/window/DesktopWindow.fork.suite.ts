// Fork-owned harness pieces and cases for `DesktopWindow.test.ts`. The upstream
// file reaches them through `fork-hook` lines, so it keeps only upstream cases
// and its harness stays upstream's text (RSI-Software/t3code-hyprws#1493).
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import type { DesktopWindowHarnessFork } from "./DesktopWindow.test.ts";

/**
 * Upstream's test environment plus the variables a fork case opts into. The
 * harness merges it after upstream's environment layer, so it wins when set.
 */
export const desktopEnvironmentLayerFork = (
  input: Parameters<typeof DesktopEnvironment.layer>[0],
  env: Record<string, string | undefined> | undefined,
) =>
  env === undefined
    ? Layer.empty
    : DesktopEnvironment.layer(input).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            DesktopConfig.layerTest({
              T3CODE_PORT: "3773",
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
              ...env,
            }),
          ),
        ),
      );

/**
 * Registers the fork's cases inside upstream's `DesktopWindow` suite, so they
 * share its harness. Each fork domain adds its cases here.
 */
export const registerDesktopWindowForkTests = (_harness: DesktopWindowHarnessFork) => {};
