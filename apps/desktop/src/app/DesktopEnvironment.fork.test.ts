import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;
const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));
const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));
describe("DesktopEnvironment", () => {
  it.effect("resolves agent placement only for a valid development launch", () =>
    Effect.gen(function* () {
      const placement = yield* makeEnvironment(
        {},
        {
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DESKTOP_AGENT_WORKSPACE: "8",
          T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE: "t3code-dev-agent-abc",
        },
      );
      assert.deepEqual(
        placement.devAgentPlacement,
        Option.some({ workspace: 8, title: "t3code-dev-agent-abc" }),
      );
      const production = yield* makeEnvironment(
        {},
        {
          T3CODE_DESKTOP_AGENT_WORKSPACE: "8",
          T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE: "t3code-dev-agent-abc",
        },
      );
      assert.deepEqual(production.devAgentPlacement, Option.none());
      const invalid = yield* makeEnvironment(
        {},
        {
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          T3CODE_DESKTOP_AGENT_WORKSPACE: "0",
          T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE: "invalid,title",
        },
      );
      assert.deepEqual(invalid.devAgentPlacement, Option.none());
    }),
  );
  it.effect("keeps devtools on by default and lets a dev run opt out", () =>
    Effect.gen(function* () {
      const defaults = yield* makeEnvironment({}, { VITE_DEV_SERVER_URL: "http://localhost:5173" });
      assert.equal(defaults.devToolsEnabled, true);
      for (const value of ["0", "false", "off"]) {
        const environment = yield* makeEnvironment(
          {},
          { VITE_DEV_SERVER_URL: "http://localhost:5173", T3CODE_DESKTOP_DEVTOOLS: value },
        );
        assert.equal(environment.devToolsEnabled, false, value);
      }
    }),
  );
});
