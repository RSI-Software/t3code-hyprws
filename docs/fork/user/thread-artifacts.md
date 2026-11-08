# Thread artifacts

Agents link the files they write to the thread, such as HTML visualizations, plans, and notes.
A linked file stays **one click away** and its open preview **reloads on each edit**.

## Find them

- **Badge** on the sidebar row and branch toolbar
- **Thread details**, one row per artifact
- **Artifacts tab** under **+** in the right panel

## Link and unlink

Ask the agent to **link a file**; any local path on the host works, but **not network shares**.
To unlink, use **Unlink from thread** in the row's menu on the Artifacts tab.

T3 Code **never creates, moves, or deletes** artifact files: a deleted file shows as **Missing**, and deleting a thread removes only its links.

## HTML artifacts

HTML artifacts get **no T3 Code theme variables**, unlike chat HTML renders.
Give each file its own CSS, with fallbacks such as `var(--foreground, #171717)`.
