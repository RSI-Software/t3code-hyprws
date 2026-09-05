# Managed terminals and checkout moves

When **Managed zmux terminals** is enabled in project settings, T3 Code keeps a thread's shell attached to the zmux session owned by its checkout. The first terminal open may create or restore that session. A failure is shown in the terminal instead of silently opening a different shell.

Moving a started thread to another existing checkout waits while a turn is active or waiting to start. The branch selector shows the requested and effective checkout while the move is queued. After the turn settles, T3 Code resumes the provider in the destination and commits the thread's new checkout. Each connected client then reattaches its following terminal views from that committed state; a remote or disconnected client does the same after it receives the state on reconnect. Hidden terminals stay asleep. A partial move lists the steps that succeeded and offers **Retry**. A completed move offers **Undo**, which is accepted only while the physical checkout still matches the completed move. Web, desktop, and mobile show the same status and recovery action.

Terminal views follow their thread by default. Choose **Pin to this checkout** in the terminal menu to keep that device's view at its current checkout. The preference is local to that browser or mobile device. Choose **Follow thread checkout** to reattach that same view to the thread's current effective checkout. Other devices and external zmux clients are not closed or moved by a pinned view.

Follow and pin controls are temporarily disabled while a move is queued or preparing. This keeps the local terminal intent stable until the authoritative transition settles. Terminal attachment identities and follow or pin preferences stay local to each device; they are not included in a checkout move request.

Managed terminals require the T3 server host to provide a compatible `zmux` binary. The required command surface includes `zmux checkout ensure` and `zmux open --ready-token`; these commands may exist before a numbered zmux release includes them. Remote browsers and mobile devices use the server host's zmux installation, not a binary installed on the client.

If zmux is unavailable or too old, T3 Code preserves the existing terminal and reports an actionable failure. Update or configure zmux on the server host, then retry the terminal open or checkout move. A restorable session is restored through zmux before attachment. T3 Code never infers a replacement from a shell's current directory.

Managed attachment uses explicit shell escape mode when it starts a shell through zmux. Shell startup files and environment variables still apply inside the attached shell; T3 Code does not move arbitrary processes between checkouts.
