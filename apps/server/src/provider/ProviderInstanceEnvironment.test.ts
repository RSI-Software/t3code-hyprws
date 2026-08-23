import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("strips inherited tmux environment without changing unrelated values", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
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
});
