# Workspace files

## Show ignored files

Workspace file trees hide paths matched by Git ignore rules.

Open **Settings → General**.
Turn on **Show ignored files**.
On web and desktop the file-tree toolbar carries the same toggle.
The preference applies to that device until you turn it off.

Showing ignored files does not modify them or change the repository's ignore rules.

## Follow external workspace symlinks

Workspace file reads stay inside each project by default.
A preview is blocked when its path crosses a symlink whose target is outside the project root.

Open **Settings → General**.
Turn on **Follow external workspace symlinks** to follow those links for every project on the server.
Turn it off to restore the containment guard.

This affects workspace file reads only.
It does not create symlinks or change their targets.
