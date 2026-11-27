# Outside agents in the hyprws build

The hyprws build ships **without T3 Connect**, so agents reach an environment at **its own address**.
[Outside agents](../../user/outside-agents.md) covers the rest; this page covers **what differs**.

## Add T3 Code to an app

Open **Use T3 Code in another app (MCP)** from `Ctrl+K` or **Settings → Sharing & access**:

1. Pick the **app**
2. Pick what it **may do**
3. Copy the **URL** and get a **code**
4. Paste the code on the app's **sign-in page**

A code works **once**, for **5 minutes**, and approves **only that level**.

- **An app on this computer** uses the `localhost` URL
- **A cloud app** needs a reachable **https** address

[Tailscale HTTPS](../../user/remote-access.md#tailscale-https) **gives one**.

## Agents without a browser

A headless agent or bot signs in with a **device grant**, approved **on the host**:

```bash
t3 auth device list
t3 auth device approve <user-code> --mcp-all-projects
```

- **Read only** by default
- `--mcp-coordinate` lets it **start and steer** threads
- `--mcp-project <id>` limits it to **one project**
- **Revoke** with `t3 auth session revoke <id>`

Such a client calls **`/api/mcp/external`**, not `/mcp`.
