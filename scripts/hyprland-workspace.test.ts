import { assert, it } from "@effect/vitest";

import {
  parseHyprlandWorkspaceResponse,
  parseWorkspaceReporterArguments,
  runWorkspaceReporter,
  type WorkspaceReporterDependencies,
} from "./hyprland-workspace.ts";

it("parses the optional delay", () => {
  assert.deepStrictEqual(parseWorkspaceReporterArguments([]), { kind: "report", delaySeconds: 0 });
  assert.deepStrictEqual(parseWorkspaceReporterArguments(["-t", "1.5"]), {
    kind: "report",
    delaySeconds: 1.5,
  });
});

it("rejects malformed arguments", () => {
  assert.throws(() => parseWorkspaceReporterArguments(["--wat"]), /unknown argument/u);
  assert.throws(() => parseWorkspaceReporterArguments(["-t"]), /requires a value/u);
  assert.throws(() => parseWorkspaceReporterArguments(["-t", "-1"]), /non-negative/u);
  assert.throws(() => parseWorkspaceReporterArguments(["-t", "1", "-t", "2"]), /only once/u);
});

it("parses active workspace and active window responses", () => {
  assert.deepStrictEqual(parseHyprlandWorkspaceResponse('{"id":4,"name":"4"}', "activeworkspace"), {
    id: 4,
    name: "4",
  });
  assert.deepStrictEqual(
    parseHyprlandWorkspaceResponse(
      '{"workspace":{"id":-99,"name":"special:scratch"}}',
      "activewindow",
    ),
    { id: -99, name: "special:scratch" },
  );
});

it("captures the app workspace before waiting and the focused workspace afterward", async () => {
  const events: string[] = [];
  let stdout = "";
  const dependencies: WorkspaceReporterDependencies = {
    readActiveWindowWorkspace: () => {
      events.push("app");
      return { id: 4, name: "4" };
    },
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
    },
    readActiveWorkspace: () => {
      events.push("focused");
      return { id: 7, name: "code" };
    },
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: () => undefined,
  };

  assert.strictEqual(await runWorkspaceReporter(["-t", "2"], dependencies), 0);
  assert.deepStrictEqual(events, ["app", "sleep:2000", "focused"]);
  assert.strictEqual(stdout, "focused=code app=4\n");
});

it("handles both help aliases before touching Hyprland", async () => {
  const output: string[] = [];
  const dependencies: WorkspaceReporterDependencies = {
    readActiveWindowWorkspace: () => assert.fail("unexpected Hyprland query"),
    readActiveWorkspace: () => assert.fail("unexpected Hyprland query"),
    sleep: async () => assert.fail("unexpected sleep"),
    writeStdout: (value) => output.push(value),
    writeStderr: () => undefined,
  };

  assert.strictEqual(await runWorkspaceReporter(["--help"], dependencies), 0);
  assert.strictEqual(await runWorkspaceReporter(["-h"], dependencies), 0);
  assert.match(output.join(""), /Usage: vp run hypr:workspace/u);
});

it("distinguishes usage errors from Hyprland failures", async () => {
  let stderr = "";
  const dependencies: WorkspaceReporterDependencies = {
    readActiveWindowWorkspace: () => {
      throw new Error("no compositor");
    },
    readActiveWorkspace: () => assert.fail("unexpected focused workspace query"),
    sleep: async () => undefined,
    writeStdout: () => undefined,
    writeStderr: (value) => {
      stderr += value;
    },
  };

  assert.strictEqual(await runWorkspaceReporter(["--wat"], dependencies), 2);
  assert.match(stderr, /unknown argument/u);
  stderr = "";
  assert.strictEqual(await runWorkspaceReporter([], dependencies), 1);
  assert.match(stderr, /no compositor/u);
});
