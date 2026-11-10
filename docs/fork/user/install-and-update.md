# Install and update the hyprws build

The hyprws build ships its own server releases; install and update it from this repository, not `t3.codes`.
It supports **Linux x64 only**.

## Install the server

```bash
curl -fsSL https://raw.githubusercontent.com/RSI-Software/t3code-hyprws/hyprws/scripts/install.sh | sh
t3 service install
```

This installs `t3` and runs it as a [background service](../../user/background-service.md).
It **replaces an upstream `t3`**; running both is unsupported.

## Update

- Desktop app alone **updates with the app**
- A background service uses **Update** in its notice

The sidebar update icon updates **only the desktop app**, never a separate server.

When the notice offers **Copy update command**, run it on the server's host:

```bash
t3 update <version>
```

[Updating T3 Code](../../user/updating.md) covers restarts and failed updates.

## Switch channel

- **Stable** follows each upstream stable
- **Nightly** follows every upstream nightly

Move a server to stable with the command below; nightly is `--channel nightly`.

```bash
t3 update --channel stable --allow-downgrade
```

A **database change** only the newer release supports **blocks the move**.
