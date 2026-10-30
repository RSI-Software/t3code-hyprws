# Thread artifacts

Agents link the documents they write to the thread: trackers, plans, investigation notes.
A linked file stays one click away and shows each edit without a new chat message.

## Find them

- **Badge:** sidebar row and branch toolbar
- **Hover:** the badge lists each artifact
- **Thread details:** one row per artifact
- **Artifacts tab:** right panel, **+ → Artifacts**

Opening an artifact shows it in the file panel.
The open preview reloads when the file changes.

## Link and unlink

Agents call `link_artifact` after writing a file.
Any local path on the host works, inside or outside the project, such as a scratch folder.
Network share paths are refused.

To unlink, open the Artifacts tab, then the row's menu, then **Unlink from thread**.
Unlinking never touches the file.

## Files stay yours

T3 Code never creates, moves, or deletes artifact files.

- **File gone:** the row shows **Missing**
- **Restored file:** the row clears itself
- **Deleted thread:** only its links go

Whoever wrote a file cleans it up.

## HTML artifacts

HTML artifacts render like any HTML file in the file panel.
Unlike chat HTML renders, they get no T3 Code theme variables.
Give each file its own CSS, with fallbacks such as `var(--foreground, #171717)`.
