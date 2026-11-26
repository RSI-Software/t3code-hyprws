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

Update as [Updating T3 Code](../../user/updating.md) describes; `t3 update` reads this repository's releases.

## Switch channel

- **Stable** follows each upstream stable
- **Nightly** ships every **`hyprws` landing**

Move a server to stable with the command below; nightly is `--channel nightly`.

```bash
t3 update --channel stable --allow-downgrade
```

A **database change** only the newer release supports **blocks the move**.
