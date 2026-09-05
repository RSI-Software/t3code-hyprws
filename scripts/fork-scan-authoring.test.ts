// @effect-diagnostics nodeBuiltinImport:off - Exercise the real read-only scan against isolated Git history.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const scanScript = NodePath.join(import.meta.dirname, "fork-scan.ts");
const encodeFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const authoringCases = [
  {
    name: "terminal attachment",
    sourcePath: "apps/web/src/state/terminalSessions.ts",
    inlineImplementation: "const [retained, setRetained] = useState(initial);",
    forkPath: "apps/web/src/state/terminalAttachmentRetention.fork.ts",
    integrationCall: "const retained = useRetainedTerminalAttachment(input, attach);",
    rule: "terminal-attachment-boundary",
    domain: "zmux-estate",
  },
  {
    name: "Claude agent options",
    sourcePath: "apps/server/src/provider/Layers/ClaudeProvider.ts",
    inlineImplementation: "export function withClaudeAgentOptions(models) { return models; }",
    forkPath: "apps/server/src/provider/Layers/ClaudeAgentOptions.fork.ts",
    integrationCall: "const models = withClaudeAgentOptions(baseModels, agents);",
    rule: "provider-agent-boundary",
    domain: "custom-agents",
  },
  {
    name: "Codex agent options",
    sourcePath: "apps/server/src/provider/Layers/CodexProvider.ts",
    inlineImplementation: "export function withCodexAgentOptions(models) { return models; }",
    forkPath: "apps/server/src/provider/Layers/CodexAgentOptions.fork.ts",
    integrationCall: "const models = withCodexAgentOptions(baseModels, agents);",
    rule: "provider-agent-boundary",
    domain: "custom-agents",
  },
  {
    name: "physical sidebar scope",
    sourcePath: "apps/web/src/components/Sidebar.tsx",
    inlineImplementation: "const forcedProjectGroup = projectGroups.find(matchesPhysicalProject);",
    forkPath: "apps/web/src/components/sidebar/SidebarPhysicalScope.ts",
    integrationCall: "const scope = resolveSidebarPhysicalScope(input);",
    rule: "sidebar-physical-scope",
    domain: "project-windows",
  },
  {
    name: "chat route-family selection",
    sourcePath: "apps/web/src/components/ChatView.tsx",
    inlineImplementation: 'import { resolveThreadRouteFamily } from "../threadRoutes";',
    forkPath: "apps/web/src/lib/threadRouteNavigation.ts",
    integrationCall: "const routeFamily = useThreadRouteFamily();",
    rule: "thread-route-navigation",
    domain: "project-windows",
  },
  {
    name: "command palette route-family selection",
    sourcePath: "apps/web/src/components/CommandPalette.tsx",
    inlineImplementation:
      "const routeFamily = useParams({ select: (params) => resolveThreadRouteFamily(params) });",
    forkPath: "apps/web/src/lib/threadRouteNavigation.ts",
    integrationCall: "const routeFamily = useThreadRouteFamily();",
    rule: "thread-route-navigation",
    domain: "project-windows",
  },
  {
    name: "new-thread route-family selection",
    sourcePath: "apps/web/src/hooks/useHandleNewThread.ts",
    inlineImplementation: 'import { resolveThreadRouteFamily } from "../threadRoutes";',
    forkPath: "apps/web/src/lib/threadRouteNavigation.ts",
    integrationCall: "navigate(resolveThreadRouteFamily(getCurrentRouteParams()).draft(draftId));",
    rule: "thread-route-navigation",
    domain: "project-windows",
  },
  {
    name: "pull-request route scope",
    sourcePath: "apps/web/src/routes/_chat.pull-requests.tsx",
    inlineImplementation: "const forcedProjectScope = listScope.projectRef;",
    forkPath: "apps/web/src/components/pullRequest/PullRequestProjectScope.ts",
    integrationCall: "const scope = usePullRequestProjectScope(input);",
    rule: "pull-request-project-scope",
    domain: "project-windows",
  },
  {
    name: "pull-request picker scope",
    sourcePath: "apps/web/src/components/pullRequest/PullRequestListFilters.tsx",
    inlineImplementation: "const options = projects === null ? [] : projects.map(toOption);",
    forkPath: "apps/web/src/components/pullRequest/PullRequestProjectScope.ts",
    integrationCall: "const showProjectFilter = input.showProjectFilter;",
    rule: "pull-request-project-scope",
    domain: "project-windows",
  },
  {
    name: "project-window bootstrap",
    sourcePath: "apps/web/src/state/shell.ts",
    inlineImplementation:
      "export const environmentShellBootstrappedAtom = Atom.family(readScoped);",
    forkPath: "apps/web/src/state/windowProjectBootstrap.fork.ts",
    integrationCall: "const allReady = allEnvironmentShellsBootstrappedAtom;",
    rule: "pull-request-project-scope",
    domain: "project-windows",
  },
] as const;

it.layer(NodeServices.layer)("adopted authoring guard CLI", (it) => {
  for (const example of authoringCases) {
    const { sourcePath, domain, rule } = example;
    it.effect(
      `rejects inline ${example.name}, accepts the narrow call, and leaves history advisory`,
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
            yield* encodeFixtureJson({
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
            `# Fork delta\n\n## ${domain}\n\n### Rebase scan\n\n| Path | Why |\n| --- | --- |\n| \`${sourcePath}\` | Fork integration call |\n`,
          );
          const tagged = `Fork-Domain: ${domain}\nFork-Tier: core`;
          yield* write(
            sourcePath,
            `export function upstreamMetadata() {}\n${example.inlineImplementation}\n`,
          );
          const bad = commit(`add inline ${example.name}\n\n${tagged}`);
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
          assert.include(rejected.stdout, rule);
          assert.include(rejected.stdout, "adopted authoring guard");
          const history = scan(bad, null);
          assert.strictEqual(history.status, 0, history.stderr);
          assert.include(history.stdout, "advisory");

          yield* write(
            sourcePath,
            `export function upstreamMetadata() {}\n${example.integrationCall}\n`,
          );
          yield* write(example.forkPath, `${example.inlineImplementation}\n`);
          // An unrelated existing rule stays advisory in the same selected range.
          yield* write("fixture.lock", "fixture dependency\n");
          commit(`move ${example.name} behind fork call\n\n${tagged}`);
          const repaired = scan("HEAD", bad);
          assert.strictEqual(repaired.status, 0, repaired.stderr);
          assert.include(repaired.stdout, "lockfile");
          assert.include(repaired.stdout, "advisory");
          assert.notInclude(repaired.stdout, rule);
        }),
    );
  }
});
