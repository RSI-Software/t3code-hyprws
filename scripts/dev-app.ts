#!/usr/bin/env node

/** Launch this checkout's isolated development app and editable fixture project. */

import type { DevAppOptions } from "./lib/dev-app-options.ts";

export const DEV_APP_HELP = `Launch this checkout's isolated development app and editable fixture project.

Usage:
  vp run dev:app [--external | --desktop | --preview] [options]

Surfaces:
  --external             Open the web app in an external browser (default).
  --desktop              Open the Electron development app.
  --preview              Print the ready pairing URL for the native preview.

Options:
  --workspace <selector> Desktop placement: none, +1, -1, or a positive id.
  --host <host>          Forward the backend bind host.
  --port <port>          Forward a backend port from 1 through 65535.
  --dry-run              Print the resolved launch without starting it.
  -h, --help             Show this help before loading the launcher.

Output:
  Prints the selected surface, checkout state home, and launch status.

Writes:
  Creates or reuses .t3/test-project and isolated state under .t3/userdata.
  Unless --dry-run is used, starts the selected development surface.

Exit codes:
  0 success
  1 launch or runtime failure
  2 invalid flags or usage
  130 interrupted by SIGINT
`;

interface DevAppRuntime {
  readonly runDevApp: (options: DevAppOptions) => Promise<number>;
}

interface DevAppOptionsModule {
  readonly UsageError: new (...args: ConstructorParameters<typeof Error>) => Error;
  readonly parseDevAppOptions: (argv: ReadonlyArray<string>) => DevAppOptions;
}

export interface DevAppCliDependencies {
  readonly loadOptions: () => Promise<DevAppOptionsModule>;
  readonly loadRuntime: () => Promise<DevAppRuntime>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

const defaultDependencies: DevAppCliDependencies = {
  loadOptions: () => import("./lib/dev-app-options.ts"),
  loadRuntime: () => import("./lib/dev-app.ts"),
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

export async function runDevAppCli(
  argv: readonly string[],
  dependencies: DevAppCliDependencies = defaultDependencies,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    dependencies.writeStdout(DEV_APP_HELP);
    return 0;
  }

  let optionsModule: DevAppOptionsModule;
  try {
    optionsModule = await dependencies.loadOptions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\n`);
    return 1;
  }

  let options: DevAppOptions;
  try {
    options = optionsModule.parseDevAppOptions(argv);
  } catch (error) {
    if (!(error instanceof optionsModule.UsageError)) throw error;
    dependencies.writeStderr(`error: ${error.message}\nUsage: vp run dev:app [options]\n`);
    return 2;
  }

  try {
    const runtime = await dependencies.loadRuntime();
    return await runtime.runDevApp(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runDevAppCli(process.argv.slice(2));
