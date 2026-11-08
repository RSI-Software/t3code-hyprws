# Managed terminals and checkout moves

A zmux terminal attaches to the **zmux session of its thread's checkout**, creating or restoring it on first open.
Managed terminals need a **current `zmux` on the server host**; remote browsers use the host's zmux.
If zmux is missing or too old, the terminal **reports the failure**; update zmux on the host and retry.

## Settings

Open **Settings → Terminal**:

- **Default terminal** picks plain or zmux
- **Create zmux sessions automatically** per worktree

The terminal's **+** menu offers the other shell: **New plain shell** or **New zmux shell**.

## Settle a thread

Settling or deleting a worktree thread **removes its whole zmux session**: every tab and running command, for every viewer.
The worktree and branch stay.
Unsettling creates a **fresh session**.
The base checkout's `main` session stays available.

## Move a thread to another checkout

A move **waits for a running turn**, then the provider resumes in the new checkout and following terminals reattach.
The branch selector shows both the requested and current checkout until then.

If a move **partly fails**, retry it; after a complete move, **Undo** works while the old checkout still matches.

## Follow or pin a terminal

Terminals **follow their thread** by default.
Select **Pin terminal checkout** to keep this device's view where it is, or **Follow thread checkout** to reattach.
The choice is **per browser** and locked while a move runs.
