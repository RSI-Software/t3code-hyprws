# Shared thread quiet

Spikes RSI-712 and RSI-714: in a shared thread, does a line get an **agent reply exactly when it is for the agent**?

## Arms

| Arm | Who decides | Quiet signal |
| --- | --- | --- |
| `marker712` | the agent's turn, RSI-712 rule | `(listening)` text |
| `marker` | the agent's turn, RSI-714 criteria | `(listening)` text |
| `tool` | the agent's turn, RSI-714 criteria | `stay_quiet` MCP call |
| `router` | one text-generation call before dispatch | route `people` |

- **Router** uses the **server's text generation**
- Held lines **fold** into the next ask (RSI-711)
- **One criteria text** for agent and router

## Run

```bash
cd evals
pnpm shared-thread-quiet --arm marker --out runs/marker
pnpm shared-thread-quiet --arm router --model gpt-6-luna --out runs/luna-router
pnpm shared-thread-quiet --arm tool --case relay-request --samples 1 --out runs/smoke
```

- `--model`: **`claude-haiku-5-5`**, else **Codex**
- `--router-model`: default **`--model`**
- `--samples`: default **3**
- `--concurrency`: default **6**
- `--baseline <results.json>`: **per-case column**
- `EVAL_CLAUDE_SETTINGS=<file>`: **auth-only** settings

That file keeps your **CLAUDE.md, hooks and MCP servers** out of Claude sessions.
Codex turns **still load** your global `AGENTS.md`.

## Grading

- The **last line** decides the case
- **History lines** with `expect`: a **second count**
- `stats.json`: **misses**, **unwanted**, **cost**, **time**

## Cost

A full run on Haiku costs about **$0.90 (router) to $1.60 (tool)**.

## Add a case

Add an entry to `cases.ts`: the **messages in order**, whether the last gets **`quiet` or `reply`**, its `kind`, and its `source`.
