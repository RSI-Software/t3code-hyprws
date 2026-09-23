# Install and update the hyprws build

The hyprws build ships its own server releases, so install and update it from this repository rather than `t3.codes`.
It supports Linux x64 only.

## Install the server

```bash
curl -fsSL https://raw.githubusercontent.com/RSI-Software/t3code-hyprws/hyprws/scripts/install.sh | sh
t3 service install
```

The first line puts `t3` in `~/.local/bin`; the second runs it as the `t3code.service` [background service](../../user/background-service.md).
It replaces an upstream `t3` on the same machine; running both is unsupported.

## Update

Where the server runs decides how it updates:

| Setup                                 | Server runs            | Update it with                  |
| ------------------------------------- | ---------------------- | ------------------------------- |
| Desktop app alone                     | inside the desktop app | a desktop app update            |
| Desktop app on the background service | `t3code.service`       | **Update** in the update notice |
| Server only, clients elsewhere        | `t3code.service`       | **Update** in the update notice |

The sidebar update icon updates the desktop app, never a separate server.

When the notice offers **Copy update command** instead, run the copied command on the server's host:

```sh
t3 update <version>
```

[Updating T3 Code](../../user/updating.md) covers restarts, resuming threads, and failed updates.
