// Regenerates `apps/web/src/routeTree.gen.ts` with the same generator call the
// TanStack vite plugin makes at `configResolved` (see apps/web/vite.config.ts),
// so a sync walk can restore HEAD and regenerate instead of resolving the file
// by hand (RSI-Software/t3code-hyprws#949).
//
// `@tanstack/router-generator` is reached through the fork's existing
// `@tanstack/router-plugin` dependency in apps/web; the fork adds no new
// dependency and touches no upstream package manifest.
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const webRoot = NodePath.join(repoRoot, "apps/web");

const pluginPackagePath = NodeModule.createRequire(import.meta.url).resolve(
  "@tanstack/router-plugin/package.json",
  { paths: [webRoot] },
);
// Resolving from inside the installed plugin is what makes the transitive
// generator package visible under pnpm's layout.
const generatorModule = NodeModule.createRequire(pluginPackagePath)(
  "@tanstack/router-generator",
) as {
  Generator: new (options: { config: unknown; root: string }) => { run: () => Promise<void> };
  getConfig: (inlineConfig: Record<string, never>, root: string) => unknown;
};

const config = generatorModule.getConfig({}, webRoot);
await new generatorModule.Generator({ config, root: webRoot }).run();
