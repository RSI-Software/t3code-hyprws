import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
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

  it("overrides inherited environment values and preserves explicit tmux values", () => {
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
