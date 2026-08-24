# Workspace files

## Show ignored files

Workspace file trees hide paths matched by Git ignore rules by default.

On web and desktop, select **Show ignored files** in the file-tree toolbar. You can also change it
under **Settings → General → Show ignored files**. On mobile, use the same General setting. The
preference applies to workspace file trees on that device and remains enabled until you turn it
off.

Revealing ignored files does not modify them or change the repository's ignore rules.

## Follow external workspace symlinks

T3 Code keeps workspace file reads inside each project by default. A file preview is blocked when
its path crosses a symlink whose target is outside the project root.

To follow those links for every project connected to the server, open **Settings → General** and
turn on **Follow external workspace symlinks**. Turn it off to restore the containment guard.

This setting affects workspace file reads only. It does not create symlinks or change their targets.
