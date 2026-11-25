# Shared thread quiet

Spike RSI-712: in a shared thread, the agent replies **`(listening)` alone** when people talk to each other, and **answers** when a message is for it.

## Run

```bash
cd evals
pnpm shared-thread-quiet --out runs/quiet
pnpm shared-thread-quiet --out runs/quiet --case relay-request --samples 5
```

- Each sample: a **real `claude -p` session**
- **One turn** per message
- Messages carry the **server's attribution text**
- Edit tools **off**
- `--model`: default **`claude-haiku-5-5`**
- `--case <id>`: **repeatable**
- `--samples <n>`: default **3**
- Cost: about **$0.11** a full run on Haiku

## Add a case

Add an entry to `cases.ts`: the **messages in order**, and whether the last gets **`quiet` or `reply`**.
