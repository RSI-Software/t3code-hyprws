import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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

  // fork-hook: pull-requests/attachment-media-verified-host — the attachment media path
  // runs host-agnostic probes and owner/name repositories through gh, which argv alone
  // cannot pin to the pinned credential's host. The caller-derived verifiedHost must
  // carry it: refused without the field, allowed only when it names the pinned host.
  it.effect(
    "routes the attachment media path through the pinned credential only when the verified host names it",
    () =>
      Effect.gen(function* () {
        mockRun.mockImplementation((input) =>
          Effect.succeed(processOutput(input.env?.GH_HOST === "github.com" ? "pinned" : "ambient")),
        );
        const gh = yield* GitHubCli.GitHubCli;
        const pin = GitHubCli.PinnedGitHubCredential;
        const pinned = {
          host: "github.com",
          token: Redacted.make("secret-credential"),
          credentialFingerprint: "fingerprint",
        } as const;
        // Without a verified host the media args cannot prove their target, so the
        // pinned credential is never exposed to them.
        const unproven = yield* Effect.flip(
          gh
            .execute({ cwd: "/w", args: ["image", "--version"] })
            .pipe(Effect.provideService(pin, pinned)),
        );
        expect(unproven._tag).toBe("GitHubCliCommandError");
        expect(mockRun).not.toHaveBeenCalled();
        // A wrong verified host is still refused.
        const wrong = yield* Effect.flip(
          gh
            .execute({
              cwd: "/w",
              args: ["image", "--version"],
              verifiedHost: "other.example.test",
            })
            .pipe(Effect.provideService(pin, pinned)),
        );
        expect(wrong._tag).toBe("GitHubCliCommandError");
        // The right one routes through the pinned credential.
        const version = yield* gh
          .execute({ cwd: "/w", args: ["image", "--version"], verifiedHost: "github.com" })
          .pipe(Effect.provideService(pin, pinned));
        expect(version.stdout).toBe("pinned");
        const upload = yield* gh
          .execute({
            cwd: "/w",
            args: ["image", "--repo", "acme/web", "/tmp/demo.webm"],
            verifiedHost: "github.com",
          })
          .pipe(Effect.provideService(pin, pinned));
        expect(upload.stdout).toBe("pinned");
      }).pipe(Effect.provide(layer)),
  );
});
