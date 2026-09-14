import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
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
const quotaOutput = (remaining = 5000, resetAt = "2099-01-01T00:00:00Z") =>
  processOutput(
    JSON.stringify({ data: { rateLimit: { cost: 1, limit: 5000, remaining, resetAt } } }),
  );
const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();
const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      // The budget reading upstream takes before reads must not consume the queued outputs.
      run: (input) =>
        input.args[0] === "api" &&
        input.args[1] === "graphql" &&
        input.args.at(-1)?.includes("rateLimit")
          ? Effect.succeed(quotaOutput())
          : mockRun(input),
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

  // fork-hook: upstream-fixes/attachment-media-verified-host — the attachment media path
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
describe("GitHubCli.listPullRequestsByHead", () => {
  const decodeRequest = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        query: Schema.String,
        variables: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  );
  const jsonOutput = (value: unknown) => processOutput(JSON.stringify(value));
  it.effect("reads an explicit repository instead of the one gh would pick", () =>
    Effect.gen(function* () {
      const documents: Array<{ query: string; variables: Record<string, unknown> }> = [];
      const commands: Array<ReadonlyArray<string>> = [];
      mockRun.mockImplementation((input) =>
        Effect.sync(() => {
          commands.push([input.command, ...input.args]);
          if (input.command === "git") {
            return processOutput(
              "origin\tgit@github.com:me/web.git (fetch)\nupstream\tgit@github.com:acme/web.git (fetch)\n",
            );
          }
          if (input.args[0] === "pr") return jsonOutput([]);
          documents.push(decodeRequest(input.stdin ?? ""));
          return jsonOutput({
            data: {
              repository: { h0: { nodes: [] } },
              rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
            },
          });
        }),
      );
      const gh = yield* GitHubCli.GitHubCli;
      const lookup = yield* gh
        .listPullRequestsByHead({
          cwd: "/repo",
          headSelector: "feature/a",
          state: "all",
          limit: 100,
          rateLimitHost: "github.com",
          repository: "github.com/me/web",
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(lookup);
      assert.strictEqual(
        commands.some(([command]) => command === "git"),
        false,
      );
      assert.deepStrictEqual(
        [documents[0]?.variables.owner, documents[0]?.variables.name],
        ["me", "web"],
      );

      yield* gh.listPullRequestsByHead({
        cwd: "/repo",
        headSelector: "feature/a",
        state: "all",
        limit: 100,
        rateLimitHost: "github.com",
        repository: "enterprise.test/me/web",
      });
      assert.deepStrictEqual(commands.at(-1)?.slice(9, 11), ["--repo", "enterprise.test/me/web"]);
    }).pipe(Effect.provide(layer)),
  );
});
