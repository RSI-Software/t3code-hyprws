# Terminal renderers

Terminal sessions remain server-owned PTYs. Clients receive the existing raw byte stream and send
input and resize events over the existing terminal contracts; renderer choices never cross the
wire.

## Ghostty alignment

Android and web use the official `libghostty-vt` C ABI for parsing, terminal state, grapheme
boundaries, keyboard encoding, selection, and scrollback:

- Android links the native shared library and converts render state into a compact JNI snapshot.
- Web loads a separately cached WebAssembly build and reads render state into a Canvas 2D surface.
- Both artifacts are built from the revision in
  `native/libghostty-vt/VERSION`.

The platform adapters deliberately own only platform behavior. Android owns its Kotlin Canvas and
touch integration. Web owns browser font shaping, the hidden IME textarea, clipboard and DOM input,
and its Canvas renderer. The web adapter also delegates application mouse encoding, word and line
selection, and OSC 8 hyperlink metadata to the official ABI. Browser conventions remain available:
holding Shift bypasses application mouse capture, and the platform link modifier opens hyperlinks.
React does not participate in terminal frames.

The web runtime is singleton-scoped per browser tab so split terminals share one compiled module
and memory. Each visible terminal owns and frees its own terminal, render state, row iterator, cell
iterator, key and mouse encoder, and input event handles. Restoring captured scrollback temporarily
detaches the PTY callback so historical device queries cannot emit replies into the current shell.

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

## Updating Ghostty

Update and rebuild Android first, because mobile's `VERSION` file is the single source of truth for
the upstream pin (the upstream `LICENSE` lives beside it). Then run:

```sh
pnpm --dir apps/web build:ghostty-wasm
```

Commit the regenerated web `wasm` artifacts. The build embeds the pinned revision into the binary as
semver build metadata, and the focused web ABI test reads it back through `ghostty_build_info` and
compares it against mobile's `VERSION` — so the web vendor directory holds only the artifacts, drift
cannot hide, and there is no second pin to keep in sync. The same test enforces the artifact budget
and exercises repeated create/write/free cycles with multi-codepoint graphemes.
