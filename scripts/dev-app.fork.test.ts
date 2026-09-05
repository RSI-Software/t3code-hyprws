import { assert, describe, it } from "@effect/vitest";

import { DEV_APP_HELP, runDevAppCli, type DevAppCliDependencies } from "./dev-app.ts";
import { parseDevAppOptions, UsageError, type DevAppOptions } from "./lib/dev-app-options.ts";

const loadOptions = async () => ({ parseDevAppOptions, UsageError });

describe("dev app options", () => {
  it("defaults to the external web surface and forwards launch options", () => {
    assert.deepStrictEqual(parseDevAppOptions([]), {
      surface: "external",
      dryRun: false,
    });
    assert.deepStrictEqual(
      parseDevAppOptions([
        "--desktop",
        "--workspace",
        "+1",
        "--host",
        "0.0.0.0",
        "--port",
        "4317",
        "--dry-run",
      ]),
      {
        surface: "desktop",
        workspace: "+1",
        host: "0.0.0.0",
        port: 4317,
        dryRun: true,
      },
    );
    assert.deepStrictEqual(parseDevAppOptions(["--preview"]), {
      surface: "preview",
      dryRun: false,
    });
    assert.deepStrictEqual(parseDevAppOptions(["--external"]), {
      surface: "external",
      dryRun: false,
    });
  });

  it("enforces mutually exclusive surfaces and desktop-only placement", () => {
    assert.throws(() => parseDevAppOptions(["--external", "--desktop"]), /mutually exclusive/u);
    assert.throws(() => parseDevAppOptions(["--desktop", "--preview"]), /mutually exclusive/u);
    assert.throws(() => parseDevAppOptions(["--workspace", "2"]), /only with --desktop/u);
    assert.throws(
      () => parseDevAppOptions(["--preview", "--workspace", "2"]),
      /only with --desktop/u,
    );
  });

  it("validates workspace selectors, ports, values, and duplicates", () => {
    for (const workspace of ["none", "+1", "-1", "1", "999"]) {
      assert.equal(
        parseDevAppOptions(["--desktop", "--workspace", workspace]).workspace,
        workspace,
      );
    }
    for (const workspace of ["0", "-2", "+2", "workspace", "9007199254740992"]) {
      assert.throws(
        () => parseDevAppOptions(["--desktop", "--workspace", workspace]),
        /invalid --workspace/u,
      );
    }
    assert.equal(parseDevAppOptions(["--port", "1"]).port, 1);
    assert.equal(parseDevAppOptions(["--port", "65535"]).port, 65_535);
    for (const port of ["0", "65536", "1.5", "nope"]) {
      assert.throws(() => parseDevAppOptions(["--port", port]), /invalid --port/u);
    }
    assert.throws(() => parseDevAppOptions(["--port"]), /requires a value/u);
    assert.throws(() => parseDevAppOptions(["--host", "  "]), /non-empty/u);
    assert.throws(() => parseDevAppOptions(["--dry-run", "--dry-run"]), /duplicate/u);
    assert.throws(() => parseDevAppOptions(["--home-dir", ".other"]), /unknown argument/u);
    assert.throws(() => parseDevAppOptions(["project"]), /unexpected positional/u);
  });
});

describe("dev app CLI", () => {
  it("serves bounded help through both aliases before loading the runtime", async () => {
    for (const helpFlag of ["--help", "-h"]) {
      let imports = 0;
      let stdout = "";
      const status = await runDevAppCli([helpFlag, "--reserved-unknown"], {
        loadOptions: async () => {
          imports += 1;
          throw new Error("must not load");
        },
        loadRuntime: async () => {
          imports += 1;
          throw new Error("must not load");
        },
        writeStdout: (value) => {
          stdout += value;
        },
        writeStderr: () => assert.fail("help wrote to stderr"),
      });
      assert.equal(status, 0);
      assert.equal(imports, 0);
      assert.equal(stdout, DEV_APP_HELP);
      assert.isAtMost(stdout.trimEnd().split("\n").length, 40);
      assert.include(stdout, "--workspace <selector>");
      assert.include(stdout, "Exit codes:");
    }
  });

  it("rejects unknown flags with status 2 before loading the runtime", async () => {
    let imports = 0;
    let stderr = "";
    const status = await runDevAppCli(["--reserved-unknown"], {
      loadOptions,
      loadRuntime: async () => {
        imports += 1;
        throw new Error("must not load");
      },
      writeStdout: () => assert.fail("usage error wrote to stdout"),
      writeStderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(status, 2);
    assert.equal(imports, 0);
    assert.include(stderr, "unknown argument: --reserved-unknown");
    assert.include(stderr, "Usage: vp run dev:app");
  });

  it("forwards parsed options and preserves the runtime status", async () => {
    let received: DevAppOptions | undefined;
    const dependencies: DevAppCliDependencies = {
      loadOptions,
      loadRuntime: async () => ({
        runDevApp: async (options) => {
          received = options;
          return 130;
        },
      }),
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    };

    const status = await runDevAppCli(
      ["--desktop", "--workspace=-1", "--host", "localhost", "--port", "13773"],
      dependencies,
    );
    assert.equal(status, 2);
    assert.isUndefined(received);

    const forwardedStatus = await runDevAppCli(
      ["--desktop", "--workspace", "-1", "--host", "localhost", "--port", "13773"],
      dependencies,
    );
    assert.equal(forwardedStatus, 130);
    assert.deepStrictEqual(received, {
      surface: "desktop",
      workspace: "-1",
      host: "localhost",
      port: 13_773,
      dryRun: false,
    });
  });

  it("reports runtime failures with status 1", async () => {
    let stderr = "";
    const status = await runDevAppCli([], {
      loadOptions,
      loadRuntime: async () => ({
        runDevApp: async () => {
          throw new Error("launcher failed");
        },
      }),
      writeStdout: () => undefined,
      writeStderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(status, 1);
    assert.equal(stderr, "error: launcher failed\n");
  });
});
