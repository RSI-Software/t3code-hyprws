# Managed terminals and checkout moves

With **Managed zmux terminals** on in project settings, a thread's shell attaches to the zmux session owned by its checkout.
The first terminal open may create or restore that session.
A failure is reported in the terminal instead of silently opening a different shell.

## Requirements

Managed terminals need a compatible `zmux` on the T3 server host, including `zmux checkout ensure` and `zmux open --ready-token`.
Those commands may exist before a numbered zmux release includes them.
Remote browsers and mobile devices use the server host's zmux, not a binary on the client.

If zmux is unavailable or too old, T3 Code preserves the existing terminal and reports the failure.
Update or configure zmux on the host, then retry.

## Settle a thread

Settling or deleting a worktree thread removes its entire zmux session, including every tab and running command.
This also disconnects other viewers and threads using that session.
Settlement keeps the worktree and branch, but discards the session permanently.
Unsettling does not restore it; opening a terminal creates a fresh session.
The base checkout's `main` session stays available.
Configured settle scripts run in independent shells so session removal does not interrupt them.

## Move a thread to another checkout

1. The move queues while a turn runs or waits.
2. Branch selector shows requested and effective.
3. The turn settles; the provider resumes there.
4. The new checkout commits.
5. Clients reattach following terminals.

A remote or disconnected client reattaches once it receives the committed state.
Hidden terminals stay asleep.

**Recovery**

| Outcome      | Offer                                               |
| ------------ | --------------------------------------------------- |
| **Partial**  | the steps that succeeded, plus **Retry**            |
| **Complete** | **Undo**, while the physical checkout still matches |

Web and desktop show the same status and recovery action.

## Follow or pin a terminal

Terminal views follow their thread by default.

| Choice                     | Effect                                        |
| -------------------------- | --------------------------------------------- |
| **Pin to this checkout**   | keeps this device's view where it is          |
| **Follow thread checkout** | reattaches to the thread's effective checkout |

The preference is local to that browser.
Pinning does not close or move other devices or external zmux clients.

Both controls are disabled while a move is queued or preparing.
Attachment identities and follow or pin preferences are never sent in a move request.

## Shell behavior

To open a shell outside zmux, choose **New plain shell** from the terminal's **+** menu.
That terminal keeps its plain-shell choice when you reload or follow another checkout.

Managed attachment starts the shell through zmux in explicit escape mode.
Shell startup files and environment variables still apply inside the attached shell.
A restorable session is restored through zmux before attachment.
T3 Code never infers a replacement checkout from a shell's current directory, and never moves arbitrary processes between checkouts.
