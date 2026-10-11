// Fork-owned search entries for Settings → Terminal (zmux-estate).
export const terminalSearchItemsFork = [
  {
    id: "terminal-session-mode",
    title: "Default terminal",
    to: "/settings/terminal",
    searchTerms: ["terminal session launch plain shell zmux tmux managed"],
  },
  {
    id: "zmux-auto-sessions",
    title: "Create zmux sessions automatically",
    to: "/settings/terminal",
    searchTerms: ["zmux tmux managed session worktree unsettle restore"],
  },
] as const;
