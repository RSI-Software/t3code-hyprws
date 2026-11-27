# Shared thread quiet

In a shared thread, does a line get an **agent reply exactly when it is for the agent**?

Each case replays its messages through **one real Claude session**, attributed as the server does.
The agent stays quiet by replying **only `(listening)`**.

## Arms

- `current`: the **server's text**, imported from source
- `rsi-712`: **RSI-712's rule**, kept as the control

## Run

```bash
cd evals
export EVAL_CLAUDE_SETTINGS=<auth-only settings file>
pnpm shared-thread-quiet --out runs/current
pnpm shared-thread-quiet --arm rsi-712 --out runs/rsi-712
pnpm shared-thread-quiet --case relay-request --samples 1 --out runs/smoke
```

- `--model`: default **`claude-haiku-5-5`**
- `--judge-model`: default **`claude-sonnet-5-5`**
- `--samples`: default **3**
- `--concurrency`: default **6**
- `--baseline <results.json>`: a **per-case column**
- `EVAL_CLAUDE_SETTINGS`: keeps **CLAUDE.md, hooks** out

## Grading

- The **last line** decides the case
- **History lines** with `expect`: a **second count**
- A miss: an ask **got no reply**
- An unwanted reply: a people line **got one**
- A `rubric` case: a **judge** grades its words too

## Cost

A full run on Haiku costs about **$1.25** per arm.

## Add a case

Add an entry to `cases.ts`: the **messages in order**, whether the last gets **`quiet` or `reply`**, its `kind`, and its `source`.
Wrap a message in `forced(...)` to send it as **"Ask the agent"**.
Set `rubric` to have a **judge grade** the last reply's words.
Set `handoffReply` to **switch models** before the last line: earlier lines reach a fresh session as the server's **inline history**.
