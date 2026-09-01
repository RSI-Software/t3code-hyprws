// @effect-diagnostics nodeBuiltinImport:off - Exercise the real read-only scan against isolated Git history.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const scanScript = NodePath.join(import.meta.dirname, "fork-scan.ts");
const sourcePath = "apps/web/src/state/terminalSessions.ts";

it.layer(NodeServices.layer)("adopted authoring guard CLI", (it) => {
  it.effect(
    "rejects newly added terminal state, accepts the narrow hook, and leaves history advisory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-scan-authoring-" });
        const git = (args: ReadonlyArray<string>) =>
          NodeChildProcess.execFileSync("git", [...args], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        const write = Effect.fn("writeFixture")(function* (path: string, content: string) {
          const absolute = NodePath.join(root, path);
          yield* fs.makeDirectory(NodePath.dirname(absolute), { recursive: true });
          yield* fs.writeFileString(absolute, content);
        });
        const commit = (message: string) => {
          git(["add", "."]);
          git([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            message,
          ]);
          return git(["rev-parse", "HEAD"]);
        };
        git(["init", "--initial-branch=fixture"]);
        yield* write(sourcePath, "export function upstreamMetadata() {}\n");
        const workflowPairs = ["ci", "release"].map((name) => ({
          upstream: `.github/workflows/${name}.yml`,
          fork: `.github/workflows/hyprws-${name}.yml`,
        }));
        for (const pair of workflowPairs) {
          yield* write(pair.upstream, "jobs: {}\n");
          yield* write(pair.fork, "jobs: {}\n");
        }
        const base = commit("upstream fixture");
        yield* write(
          ".github/fork-workflow-reviews.json",
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            version: 1,
            reviews: workflowPairs.map((pair) => ({
              ...pair,
              upstreamCommit: base,
              upstreamBlob: git(["rev-parse", `${base}:${pair.upstream}`]),
              forkBlob: git(["rev-parse", `${base}:${pair.fork}`]),
              disposition: "no-change",
              reason: "Empty fixture workflows have no distribution differences.",
            })),
          }),
        );
        yield* write(
          "docs/internals/fork-delta.md",
          "# Fork delta\n\n## zmux-estate\n\n### Rebase scan\n\n| Path | Why |\n| --- | --- |\n| `apps/web/src/state/terminalSessions.ts` | Attachment hook |\n",
        );
        const tagged = "Fork-Domain: zmux-estate\nFork-Tier: core";
        yield* write(
          sourcePath,
          "export function upstreamMetadata() {}\nconst [retained, setRetained] = useState(initial);\n",
        );
        const bad = commit(`add inline retained state\n\n${tagged}`);
        const scan = (head: string, since: string | null) =>
          NodeChildProcess.spawnSync(
            process.execPath,
            [
              scanScript,
              "--head",
              head,
              "--target",
              base,
              "--no-typecheck",
              ...(since === null ? [] : ["--since", since]),
            ],
            { cwd: root, encoding: "utf8" },
          );

        const rejected = scan("HEAD", base);
        assert.strictEqual(rejected.status, 1, rejected.stderr);
        assert.include(rejected.stdout, "terminal-attachment-boundary");
        assert.include(rejected.stdout, "adopted authoring guard");
        const history = scan(bad, null);
        assert.strictEqual(history.status, 0, history.stderr);
        assert.include(history.stdout, "advisory");

        yield* write(
          sourcePath,
          "export function upstreamMetadata() {}\nconst retained = useRetainedTerminalAttachment(input, attach);\n",
        );
        yield* write(
          "apps/web/src/state/terminalAttachmentRetention.fork.ts",
          "export function useRetainedTerminalAttachment() { return useState(initial); }\n",
        );
        // An unrelated existing rule stays advisory in the same selected range.
        yield* write("fixture.lock", "fixture dependency\n");
        commit(`move retention behind fork hook\n\n${tagged}`);
        const repaired = scan("HEAD", bad);
        assert.strictEqual(repaired.status, 0, repaired.stderr);
        assert.include(repaired.stdout, "lockfile");
        assert.include(repaired.stdout, "advisory");
        assert.notInclude(repaired.stdout, "terminal-attachment-boundary");
      }),
  );
});
