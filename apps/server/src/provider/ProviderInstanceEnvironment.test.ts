import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        "codex",
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join(NodeOS.homedir(), tail),
        CLAUDE_CONFIG_DIR: path.join(NodeOS.homedir(), tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Split by driver kind because a spawn keeps only its own provider's home:
  // the inherited value still goes through untouched, which is what this covers.
  it.each([
    { ownDriverKind: "codex", kept: { CODEX_HOME: "~/.codex" } },
    { ownDriverKind: "claudeAgent", kept: { CLAUDE_CONFIG_DIR: "~\\.claude" } },
  ])("leaves the inherited $ownDriverKind provider home unchanged", ({ ownDriverKind, kept }) => {
    const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
        ownDriverKind,
        baseEnv,
      ),
    ).toEqual({ ...kept, CUSTOM_VALUE: "~/.custom" });
  });

  it("strips inherited tmux environment without changing unrelated values", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, "codex", {
        TMUX: "/tmp/tmux-1000/default,123,0",
        TMUX_PANE: "%42",
        TMUX_TMPDIR: "/tmp/tmux-1000",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("overrides inherited environment values, preserving empty strings and explicit tmux values", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          { name: "TMUX", value: "/operator/tmux", sensitive: false },
          { name: "TMUX_PANE", value: "%7", sensitive: false },
        ],
        "codex",
        {
          ANTHROPIC_API_KEY: "inherited",
          PATH: "/bin",
          TMUX: "/tmp/tmux-1000/default,123,0",
          TMUX_PANE: "%42",
          TMUX_TMPDIR: "/tmp/tmux-1000",
        },
      ),
    ).toEqual({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
      TMUX: "/operator/tmux",
      TMUX_PANE: "%7",
    });
  });

  it("drops another harness's identity while keeping session identity and credentials", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, "codex", {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "0b6d",
        CLAUDE_EFFORT: "high",
        CLAUDE_CONFIG_DIR: "/home/dev/.claude",
        CURSOR_AGENT: "1",
        ANTHROPIC_API_KEY: "sk-ant-test",
        T3CODE_PROJECT_ID: "project-1",
        T3CODE_THREAD_ID: "thread-1",
        PATH: "/bin",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
      T3CODE_PROJECT_ID: "project-1",
      T3CODE_THREAD_ID: "thread-1",
      PATH: "/bin",
    });
  });

  it("keeps the target provider's own harness identity", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, "codex", {
        CODEX_HOME: "/home/dev/.codex",
        CODEX_THREAD_ID: "4784c777",
        CLAUDECODE: "1",
        PATH: "/bin",
      }),
    ).toEqual({
      CODEX_HOME: "/home/dev/.codex",
      CODEX_THREAD_ID: "4784c777",
      PATH: "/bin",
    });
  });

  it("drops codex identity from a claude spawn, the reciprocal of the codex case", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, "claudeAgent", {
        CODEX_THREAD_ID: "4784c777",
        CODEX_HOME: "/home/dev/.codex",
        CLAUDE_CONFIG_DIR: "/home/dev/.claude",
        PATH: "/bin",
      }),
    ).toEqual({ CLAUDE_CONFIG_DIR: "/home/dev/.claude", PATH: "/bin" });
  });

  it("treats every harness marker as foreign to an unknown driver kind", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, undefined, {
        CLAUDECODE: "1",
        CODEX_THREAD_ID: "4784c777",
        OPENCODE_INSTANCE_ID: "oc-1",
        GROK_OAUTH2_REFERRER: "t3",
        PATH: "/bin",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("lets an explicit instance variable reinstate a foreign marker", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "CLAUDE_CONFIG_DIR", value: "/operator/.claude", sensitive: false }],
        "codex",
        { CLAUDE_CONFIG_DIR: "/home/dev/.claude", PATH: "/bin" },
      ),
    ).toEqual({ CLAUDE_CONFIG_DIR: "/operator/.claude", PATH: "/bin" });
  });
});
