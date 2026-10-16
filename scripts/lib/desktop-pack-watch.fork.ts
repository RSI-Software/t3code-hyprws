import type { UserConfig } from "vite-plus/pack";

// pnpm store hardlinks can change ctime during another checkout's install.
// Workspace symlinks resolve to source paths outside node_modules.
export function withDesktopPackWatchFork(configs: UserConfig[]) {
  return configs.map((config) => ({ ...config, ignoreWatch: /[\\/]node_modules[\\/]/ }));
}
