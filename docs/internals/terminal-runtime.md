# Terminal runtime

The environment server owns PTYs, session lifetime, and retained output. Every
client, including the desktop renderer, attaches through the environment connection.
This lets clients reconnect or share a running session. Renderer choices stay local
to each client and do not change terminal contracts.

## Output and retention

[Terminal history](../../apps/server/src/terminal/Manager.ts) is incremental.
PTY callbacks append new chunks; live events carry only those chunks. Materializing
or copying full scrollback on every callback makes output cost grow with retained
history, so snapshots and coalesced persistence are the materialization boundaries.
Persistence queues the mutable history buffer and reads its latest value when the
write runs. Clear, restart, and close must drain writes before completing their
lifecycle boundary.

Server history is capped at 5,000 lines and 8 MiB of UTF-8 text per terminal, so a
long unterminated line cannot bypass retention. Eviction removes the oldest output
without splitting Unicode code points; live output is not truncated. Release
discarded chunk references immediately, even if array compaction happens later.
Client buffers have a separate 512 KiB cap. Measure throughput with full scrollback
when changing this path.

Restoration must read only the bounded tail of current or legacy history files,
skip any incomplete UTF-8 prefix, and apply the line limit. Close the read handle
before rewriting the capped file. Reading whole old logs would defeat the memory
bound during startup.

## Renderer ownership

Android and web use the same `libghostty-vt` C ABI for terminal behavior. Platform
adapters own drawing and input integration, and React stays out of terminal frames.
The web adapter shares one WebAssembly instance per browser tab while each terminal
owns and frees its own handles. The canonical upstream pin is
[`native/libghostty-vt/VERSION`](../../native/libghostty-vt/VERSION); both native and
web artifacts must be rebuilt when it changes. Web embeds the revision in its build
info so the ABI check can detect drift without a second pin.

Restoring scrollback must not send terminal replies to the current shell. Historical
device queries can otherwise provoke fresh replies that appear as junk at the
prompt. The server strips query/response traffic from retained history, and the
[web renderer](../../apps/web/src/terminal/ghostty/core.ts) detaches its PTY writer
during replay. Preserve both protections when changing retention or renderer code.

## Managed zmux visibility lifecycle

A rendered terminal surface holds a demand lease on its server attachment only while both the
surface and its browser or project window demand live rendering. Browser clients use document
visibility. Electron project windows use main-process `BrowserWindow` show, hide, minimize, and
restore events; focus is not visibility, so focusing another shown window does not release demand.
Electron does not report compositor workspace occlusion: a shown, non-minimized window moved to an
inactive Hyprland workspace still holds demand. Each split pane has its own lease.

The client attachment stream unsubscribes immediately when its last surface disappears; it does not
inherit the generic subscription cache's idle timeout. The server alone owns the short grace period.
After that grace, it terminates only the `zmux open` PTY, which detaches that tmux client. A new lease
cancels a pending suspension. A zero-demand server open gets a separate, configurable first-attach
deadline so a slow initial UI attach is not treated as ordinary backgrounding, but an abandoned open
does not retain a local PTY forever. A suspended terminal resumes from the exact workspace, session,
and target resolved by its original attachment; resume never re-resolves the worktree or falls back
to a new plain shell. The requested grid is committed before resume, so tmux never attaches at stale
dimensions.

The retained T3 scrollback is the output captured before suspension, bounded by the server's line
limit and the client's byte limit. Output produced inside tmux while no client is attached remains
subject to tmux's own pane-history policy. On resume, T3 keeps its retained scrollback and appends
what tmux redraws for the current pane; it does not import tmux's complete unseen pane history.
Input resumes on the new PTY, a current visible layout can refit afterward, and a surface that owned
focus before project-window backgrounding regains focus after the resumed snapshot reports
`running`. Subprocess activity and child-command labels shown while suspended are explicitly
last-known values from before the local client detached; tmux may have changed since. Suspended
manager records count toward bounded inactive retention. Eviction removes the visible metadata and
keeps only a separately bounded identity lease for exact-target resume; it never kills the underlying
tmux target.

Suspension does not add a required wire state or a new event kind. Released clients continue to see
the existing running session and activity event shapes. Current clients additionally decode the
optional `attachmentStatus` field from snapshots, metadata, and activity events, and present the
managed attachment as suspended.
