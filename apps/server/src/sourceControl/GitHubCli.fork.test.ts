import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: mockRun,
    }),
  ),
);
afterEach(() => {
  mockRun.mockReset();
});
describe("GitHubCli.layer", () => {
  it.effect("scopes PR creation and default branch lookup to an explicit repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("hyprws\n")));
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh.createPullRequest({
        cwd: "/repo",
        baseBranch: "hyprws",
        headSelector: "feature/origin-pr",
        title: "Origin PR",
        bodyFile: "/tmp/body.md",
        repository: "github.com/rsi-software/t3code-hyprws",
      });
      const defaultBranch = yield* gh.getDefaultBranch({
        cwd: "/repo",
        repository: "github.com/rsi-software/t3code-hyprws",
      });
      assert.strictEqual(defaultBranch, "hyprws");
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "create",
          "--base",
          "hyprws",
          "--head",
          "feature/origin-pr",
          "--title",
          "Origin PR",
          "--body-file",
          "/tmp/body.md",
          "--repo",
          "github.com/rsi-software/t3code-hyprws",
        ],
        cwd: "/repo",
        timeoutMs: 30000,
      });
      expect(mockRun).toHaveBeenNthCalledWith(2, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "repo",
          "view",
          "github.com/rsi-software/t3code-hyprws",
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name",
        ],
        cwd: "/repo",
        timeoutMs: 30000,
      });
    }).pipe(Effect.provide(layer)),
  );
});
